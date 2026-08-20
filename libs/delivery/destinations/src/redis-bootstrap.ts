/**
 * Construct the Redis-backed dedupe and rate limiter for a destination host.
 *
 * One place, because the two adapters share a client, a failure story and a
 * decision that is easy to get subtly wrong in five copies: what to do when
 * Redis is absent. Every consumer calls this and gets the same answer.
 *
 * ## Redis is required config; Redis being DOWN is not a boot failure
 *
 * The two are different states and only one of them is supported. A
 * deployment is expected to point at a Redis — a destination consumer
 * without one is the multi-replica double-send with a shorter name, not a
 * lighter configuration.
 *
 * But an unreachable Redis at boot, or an `ioredis` that will not load,
 * must not stop delivery: the client is constructed dynamically and a
 * failure yields the in-memory pair with a WARNING. That degrades the
 * guarantees — two replicas can double-send, each allows the full
 * `max_rps` — which is why the log line is a warning rather than an info,
 * and why `distributed: false` is on the returned object for a health
 * check to read.
 *
 * ## Why the client is built here and not by the caller
 *
 * The narrow structural interfaces (`DestinationDedupeRedisClient`,
 * `RateLimiterRedisClient`) exist so tests can pass fakes and so a future
 * swap to node-redis or ValKey stays drop-in. Keeping the one real
 * construction site in this module means the `ioredis` import appears once
 * in the package rather than once per consumer.
 */

import type { Logger } from "@polaris/observability-logger";
import { type DestinationDedupe, InMemoryDestinationDedupe } from "./dedupe.js";
import { createRedisDestinationDedupe, type DestinationDedupeRedisClient } from "./dedupe-redis.js";
import { DestinationRateLimiter, type DestinationRateLimiterLike } from "./rate-limiter.js";
import { createRedisDestinationRateLimiter } from "./rate-limiter-redis.js";

/** The slice of a Polaris Redis config this needs. */
export interface DestinationRedisConfig {
  readonly host: string;
  readonly port: number;
  readonly password?: string | undefined;
  readonly db?: number | undefined;
  readonly tls?: boolean | undefined;
}

export interface DestinationSharedStateOptions {
  readonly redis?: DestinationRedisConfig | undefined;
  readonly logger: Logger;
  /** Namespace prefix. Defaults to `polaris:dst`. */
  readonly keyPrefix?: string;
  /** Injected client, for tests. Skips the dynamic import entirely. */
  readonly client?: (DestinationDedupeRedisClient & RedisLimiterSurface) | undefined;
}

/** The limiter half of the client surface. */
interface RedisLimiterSurface {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
}

export interface DestinationSharedState {
  readonly dedupe: DestinationDedupe;
  readonly rateLimiter: DestinationRateLimiterLike;
  /** `false` when the pair fell back to per-process implementations. */
  readonly distributed: boolean;
}

export async function createDestinationSharedState(
  options: DestinationSharedStateOptions,
): Promise<DestinationSharedState> {
  const client = options.client ?? (await connect(options));
  if (client === undefined) {
    options.logger.warn(
      { component: "destination.shared-state" },
      "destination dedupe and rate limiting are PER-PROCESS: two replicas can double-send " +
        "the same event, and each will allow the full max_rps on its own",
    );
    return {
      dedupe: new InMemoryDestinationDedupe(),
      rateLimiter: new DestinationRateLimiter(),
      distributed: false,
    };
  }

  const prefix = options.keyPrefix ?? "polaris:dst";
  return {
    dedupe: createRedisDestinationDedupe({
      client,
      keyPrefix: `${prefix}:dedupe`,
      logger: options.logger,
    }),
    rateLimiter: createRedisDestinationRateLimiter({
      client,
      keyPrefix: `${prefix}:rps`,
      logger: options.logger,
    }),
    distributed: true,
  };
}

async function connect(
  options: DestinationSharedStateOptions,
): Promise<(DestinationDedupeRedisClient & RedisLimiterSurface) | undefined> {
  if (options.redis === undefined) return undefined;
  try {
    // Dynamic, so a consumer wired with injected fakes never loads ioredis,
    // and so a deployment without it degrades rather than failing to boot.
    const mod = (await import("ioredis")) as unknown as {
      readonly default?: new (
        opts: Record<string, unknown>,
      ) => DestinationDedupeRedisClient & RedisLimiterSurface;
    };
    const Ctor = mod.default;
    if (typeof Ctor !== "function") return undefined;
    return new Ctor({
      host: options.redis.host,
      port: options.redis.port,
      ...(options.redis.password !== undefined ? { password: options.redis.password } : {}),
      ...(options.redis.db !== undefined ? { db: options.redis.db } : {}),
      ...(options.redis.tls === true ? { tls: {} } : {}),
      // A delivery must not stall on a slow cache. Both adapters catch and
      // fall back, so a fast failure is strictly better than a long one.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
  } catch (err) {
    options.logger.warn(
      { component: "destination.shared-state", err },
      "could not construct a Redis client for destination shared state",
    );
    return undefined;
  }
}
