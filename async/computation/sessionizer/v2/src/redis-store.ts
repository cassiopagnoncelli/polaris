/**
 * Redis-backed `SessionStore` (ADR 0005).
 *
 * Session state is TTL-shaped: a record is alive for the inactivity
 * window and must then be forgotten. Redis key expiry *is* that rule, so
 * this adapter carries no sweeper and no expiry bookkeeping — `SET key
 * value EX <inactivity>` on every write, and an absent key is an expired
 * session.
 *
 * ## Why this throws where the ingester's dedupe store does not
 *
 * `apps/ingester-api/src/dedupe/redis.ts` swallows every Redis failure
 * and returns `skipped`, because dedupe is a retry-storm absorber and
 * losing it degrades nothing that matters. This store is the opposite:
 * without the prior record the sessionizer cannot tell a continuation
 * from a new session, and continuing anyway would mint a fresh
 * `session_id` for an in-flight session and emit a `session.started`
 * that is simply wrong. Wrong session data is worse than late session
 * data.
 *
 * So a Redis failure propagates. The runtime's error path classifies it,
 * the transport does not advance the checkpoint, and the message is
 * redelivered — at-least-once doing exactly what it exists for. A Redis
 * outage therefore stalls the sessionizer rather than corrupting it,
 * which is the trade ADR 0005 records.
 *
 * @see async/computation/sessionizer/v1/src/store.ts for the TTL-vs-event-time note
 */

import type { RedisConfig } from "@polaris/runtime-config";
import type { Logger } from "@polaris/observability-logger";
import type { RedisOptions } from "ioredis";

import type { SessionStore } from "./store.js";
import type { SessionRecord } from "./transform.js";

/**
 * Minimum Redis client surface this store uses. Declared structurally so
 * tests can pass a fake without importing `ioredis`, matching the
 * ingester's dedupe-store convention.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<"OK" | null | string>;
  del(key: string): Promise<number>;
  quit?(): Promise<unknown>;
  on?(event: "error" | "ready" | "end" | "connect", listener: (err?: unknown) => void): unknown;
}

export interface CreateRedisSessionStoreOptions {
  readonly client: RedisClientLike;
  /** Namespace prefix; keys are `<prefix>:<store_key>`. */
  readonly keyPrefix: string;
  /** Hard deadline per Redis call. A slow Redis becomes a fast failure. */
  readonly opTimeoutMs: number;
  readonly logger?: Logger;
}

export interface RedisSessionStore extends SessionStore {
  /** Connection health, driven by the client's event stream. For `/ready`. */
  isHealthy(): boolean;
  close(): Promise<void>;
}

export function createRedisSessionStore(
  options: CreateRedisSessionStoreOptions,
): RedisSessionStore {
  const { client, keyPrefix, opTimeoutMs, logger } = options;

  let healthy = false;
  client.on?.("connect", () => {
    logger?.info({ component: "sessionizer.store" }, "redis session store connected");
    healthy = true;
  });
  client.on?.("ready", () => {
    healthy = true;
  });
  client.on?.("error", (err) => {
    healthy = false;
    logger?.warn(
      { component: "sessionizer.store", err: errSummary(err) },
      "redis session store error",
    );
  });
  client.on?.("end", () => {
    healthy = false;
  });

  return {
    async get(store_key) {
      const raw = await withTimeout(
        client.get(sessionKey(keyPrefix, store_key)),
        opTimeoutMs,
        "redis_get_timeout",
      );
      if (raw === null) return undefined;
      const parsed = parseRecord(raw);
      if (parsed === undefined) {
        // A corrupt value is treated as an absent one: the next event
        // opens a fresh session, which is the same outcome the record
        // expiring would have produced. Throwing would pin the partition
        // on a value no redelivery can fix.
        logger?.warn(
          { component: "sessionizer.store", store_key },
          "discarding unparsable session record",
        );
        return undefined;
      }
      return parsed;
    },

    async set(store_key, record, ttl_seconds) {
      // `EX` re-arms the window on every write, so an active session
      // stays alive and an abandoned one falls out without a sweeper.
      // Guard the floor: Redis rejects a non-positive EX.
      const ttl = Math.max(1, Math.floor(ttl_seconds));
      await withTimeout(
        client.set(sessionKey(keyPrefix, store_key), JSON.stringify(record), "EX", ttl),
        opTimeoutMs,
        "redis_set_timeout",
      );
    },

    async delete(store_key) {
      await withTimeout(
        client.del(sessionKey(keyPrefix, store_key)),
        opTimeoutMs,
        "redis_del_timeout",
      );
    },

    isHealthy: () => healthy,

    async close() {
      try {
        await client.quit?.();
      } catch (err) {
        logger?.warn(
          { component: "sessionizer.store", err: errSummary(err) },
          "redis session store close error",
        );
      }
    },
  };
}

/**
 * Compose the Redis key. Namespaced by prefix; `store_key` already
 * carries `project_id` and `environment`, so two projects cannot collide.
 */
export function sessionKey(prefix: string, store_key: string): string {
  return `${prefix}:${store_key}`;
}

/**
 * Build `RedisOptions` from the typed `RedisConfig`.
 *
 * `enableOfflineQueue: false` and `maxRetriesPerRequest: 0` matter here
 * for the same reason they do in the ingester: without them a command
 * issued while the connection is down queues silently and resolves
 * minutes later, which turns a clean stall into an unbounded one.
 */
export function buildRedisOptions(config: RedisConfig): RedisOptions {
  const options: RedisOptions = {
    host: config.host,
    port: config.port,
    db: config.db,
    connectTimeout: config.connectTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  };
  if (config.username !== undefined) options.username = config.username;
  if (config.password !== undefined) options.password = config.password;
  if (config.keyPrefix !== undefined) options.keyPrefix = config.keyPrefix;
  return options;
}

function parseRecord(raw: string): SessionRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as SessionRecord;
    // Structural floor: without these the transform cannot decide.
    if (typeof record.session_id !== "string" || typeof record.last_seen_at !== "string") {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  if (ms <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(reason));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
