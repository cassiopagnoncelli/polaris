import type { RedisOptions } from "ioredis";

import type { RedisConfig } from "@polaris/shared-config";
import type { Logger } from "@polaris/shared-logger";

import type { DedupeClaimInput, DedupeClaimOutcome, DedupeStore } from "./types.js";

/**
 * Minimum Redis client surface used by the dedupe store.
 *
 * Declared structurally so tests can pass a fake without importing `ioredis`.
 * In production we instantiate `new IORedis(...)` and pass it in.
 */
export interface RedisClientLike {
  set(
    key: string,
    value: string,
    mode1: "EX",
    ttl: number,
    mode2: "NX",
  ): Promise<"OK" | null | string>;
  quit?(): Promise<unknown>;
  on?(event: "error" | "ready" | "end" | "connect", listener: (err?: unknown) => void): unknown;
}

/**
 * Options accepted by `createRedisDedupeStore`. The wrapper is responsible
 * for SET NX EX semantics, key namespacing, op-timeout enforcement, and
 * graceful "Redis is down" fallback (return `skipped`, not throw).
 */
export interface CreateRedisDedupeStoreOptions {
  readonly client: RedisClientLike;
  readonly keyPrefix: string;
  /** Hard deadline applied to the SET NX EX call. */
  readonly opTimeoutMs: number;
  readonly logger?: Logger;
  /**
   * Hook fired on the first error after a healthy period — used by the
   * Fastify app to drop the dedupe Prometheus health gauge.
   */
  readonly onHealthChange?: (healthy: boolean) => void;
}

/**
 * Build a Redis-backed `DedupeStore`.
 *
 * The wrapper:
 *
 *   - composes the canonical key shape
 *     `<prefix>:<project_id>:<environment>:<event_id>`
 *   - applies a short op-timeout (default 50 ms in config) so a slow Redis
 *     never blocks ingestion
 *   - returns `skipped` (never throws) on timeout, network error, or any
 *     transient backend failure; the caller continues without dedupe
 *   - exposes `isHealthy()` driven by the `connect`/`error` event stream
 */
export function createRedisDedupeStore(options: CreateRedisDedupeStoreOptions): DedupeStore {
  const { client, keyPrefix, opTimeoutMs, logger } = options;

  // The healthy flag starts pessimistic and flips true once we observe a
  // `connect` (or `ready`) event. Until then, claims still try — the SET
  // call itself either succeeds or fails fast. `isHealthy()` is mostly
  // useful for the `/ready` probe.
  let healthy = false;
  const setHealthy = (next: boolean): void => {
    if (healthy === next) return;
    healthy = next;
    options.onHealthChange?.(next);
  };

  client.on?.("connect", () => {
    logger?.info({ component: "ingest.dedupe" }, "redis dedupe store connected");
    setHealthy(true);
  });
  client.on?.("ready", () => {
    setHealthy(true);
  });
  client.on?.("error", (err) => {
    setHealthy(false);
    logger?.warn(
      { component: "ingest.dedupe", err: redisErrSummary(err) },
      "redis dedupe store error",
    );
  });
  client.on?.("end", () => {
    setHealthy(false);
  });

  async function claim(input: DedupeClaimInput): Promise<DedupeClaimOutcome> {
    const key = buildDedupeKey(keyPrefix, input);
    try {
      const result = await withTimeout(
        client.set(key, "1", "EX", input.ttlSec, "NX"),
        opTimeoutMs,
        "redis_setnx_timeout",
      );
      if (result === "OK") {
        return { status: "claimed" };
      }
      // SETNX returns null when the key already existed.
      return { status: "duplicate" };
    } catch (err) {
      // We never throw out of the dedupe layer — Redis being down is an
      // operational condition, not an event-rejection condition.
      const summary = redisErrSummary(err);
      logger?.warn(
        { component: "ingest.dedupe", err: summary, key_prefix: keyPrefix },
        "redis dedupe claim failed; continuing without dedupe",
      );
      return { status: "skipped", reason: summary.message ?? "redis_error" };
    }
  }

  async function close(): Promise<void> {
    try {
      await client.quit?.();
    } catch (err) {
      logger?.warn(
        { component: "ingest.dedupe", err: redisErrSummary(err) },
        "redis dedupe store close error",
      );
    }
  }

  return {
    claim,
    isHealthy: () => healthy,
    close,
  };
}

/**
 * Compute the dedupe key. The shape is intentionally namespaced by
 * `project_id` and `environment` so the same `event_id` from two
 * environments cannot collide, and so per-project window overrides act on
 * a disjoint key space.
 */
export function buildDedupeKey(prefix: string, input: DedupeClaimInput): string {
  return `${prefix}:${input.projectId}:${input.environment}:${input.eventId}`;
}

/**
 * Build the `RedisOptions` an `ioredis` constructor needs from the typed
 * `RedisConfig`. Kept here (and not in `app.ts`) so any change to the
 * Redis wiring stays in one file.
 */
export function buildRedisOptions(config: RedisConfig): RedisOptions {
  const options: RedisOptions = {
    host: config.host,
    port: config.port,
    db: config.db,
    connectTimeout: config.connectTimeoutMs,
    // `lazyConnect: false` is the ioredis default. We rely on it so the
    // first `connect`/`error` event fires shortly after construction and
    // `isHealthy()` reflects reality before the first request lands.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  };
  if (config.username !== undefined) options.username = config.username;
  if (config.password !== undefined) options.password = config.password;
  if (config.keyPrefix !== undefined) options.keyPrefix = config.keyPrefix;
  return options;
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

function redisErrSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  if (typeof err === "string") return { message: err };
  return {};
}
