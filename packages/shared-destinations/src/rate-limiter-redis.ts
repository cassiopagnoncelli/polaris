/**
 * Redis-backed destination rate limiter.
 *
 * `max_rps` is a promise made to a VENDOR — "this destination will not send
 * you more than N requests a second". The in-memory limiter keeps that
 * promise per process, so three replicas of one consumer sent up to 3N and
 * the number an operator set was not the number the vendor saw. On a vendor
 * that answers overage with 429s, that is a self-inflicted retry storm.
 *
 * ## What is global here, and what is not
 *
 * **RPS is global.** A counter per `(destination_id, environment, second)`
 * in Redis, incremented by every replica, is what makes the operator's
 * number mean what it says.
 *
 * **Concurrency stays per-process**, and that is deliberate rather than
 * unfinished. `max_concurrency` limits how many requests one process has in
 * flight — it protects the replica's own sockets and event loop, and a
 * distributed semaphore would need lease renewal and crash recovery to
 * avoid leaking permits, which is a lot of machinery for a bound that is
 * already per-process by nature. This limiter composes with the in-memory
 * one rather than replacing it: concurrency there, RPS here.
 *
 * Stating that split matters, because "Redis-backed rate limiter" reads as
 * though both bounds became global and only one did.
 *
 * ## The window
 *
 * A fixed one-second bucket: `INCR` a key named for the current second,
 * `PEXPIRE` it on first touch. Fixed buckets admit up to 2N across a
 * boundary — N at the end of one second and N at the start of the next —
 * which a sliding window would not. That is accepted here: the alternative
 * costs a sorted set and several round trips per delivery, and vendors
 * quote RPS as a sustained rate rather than an instantaneous one.
 *
 * ## When Redis is unreachable
 *
 * The limiter falls back to the in-memory bound it already composes with.
 * Fail-open in the same sense as the dedupe: a Redis outage degrades to
 * yesterday's behaviour rather than halting delivery for every destination.
 */

import type { Logger } from "@polaris/shared-logger";

import type { DestinationInstance } from "./db/destination-instance.js";
import {
  DestinationRateLimiter,
  type DestinationRateLimiterLike,
  type RateLease,
} from "./rate-limiter.js";

/** Minimum client surface, declared structurally so tests pass a fake. */
export interface RateLimiterRedisClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
}

export interface RedisRateLimiterOptions {
  readonly client: RateLimiterRedisClient;
  /** Namespace, so one Redis can serve more than one Polaris deployment. */
  readonly keyPrefix?: string;
  /** Concurrency half. Defaults to a fresh in-memory limiter. */
  readonly concurrency?: DestinationRateLimiterLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Logger;
}

export function createRedisDestinationRateLimiter(
  options: RedisRateLimiterOptions,
): DestinationRateLimiterLike {
  const prefix = options.keyPrefix ?? "polaris:dst:rps";
  const concurrency = options.concurrency ?? new DestinationRateLimiter();
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async acquire(instance: DestinationInstance): Promise<RateLease> {
      // Concurrency first, exactly as the in-memory limiter orders it: the
      // RPS wait is held while owning a concurrency slot so waiters queue on
      // the semaphore rather than all spinning on the clock.
      const lease = await concurrency.acquire(instance);
      const startedWaiting = now();

      try {
        // Bounded. Without a cap a destination whose `max_rps` is 0, or a
        // Redis returning nonsense, would spin here forever holding a
        // concurrency slot — a livelock that looks like a hung consumer.
        for (let attempt = 0; attempt < MAX_WINDOW_WAITS; attempt++) {
          const nowMs = now();
          const second = Math.floor(nowMs / 1000);
          const key = `${prefix}:${instance.destination_id}:${instance.environment}:${String(second)}`;

          const count = await options.client.incr(key);
          if (count === 1) {
            // First toucher sets the TTL. Two seconds, not one: a key that
            // expired exactly on the boundary could be re-created by a late
            // arrival and outlive its own window.
            await options.client.pexpire(key, 2000);
          }
          if (count <= instance.max_rps) break;

          // Over budget for this second — wait for the next boundary. The
          // increment already happened and is left in place: it expires with
          // the bucket, and decrementing would race with other replicas.
          await sleep(1000 - (nowMs % 1000));
        }
      } catch (err) {
        // Fall back to the concurrency lease alone, which is the bound that
        // shipped before this. Logged, because an operator's `max_rps` is
        // silently per-process again until Redis returns.
        options.logger?.warn(
          {
            component: "destination.rate-limiter.redis",
            destination_id: instance.destination_id,
            environment: instance.environment,
            err,
          },
          "global RPS limit degraded to per-process — Redis unreachable",
        );
      }

      const acquiredAt = now();
      return {
        destination_id: lease.destination_id,
        acquired_at: acquiredAt,
        // The concurrency wait plus the RPS wait. An operator diagnosing
        // "why is this destination slow" needs the total, not one half.
        waited_ms: lease.waited_ms + (acquiredAt - startedWaiting),
        release: lease.release,
      };
    },
  };
}

/**
 * How many one-second windows `acquire` will wait through before giving up
 * and delivering anyway.
 *
 * Ten seconds is long enough that a genuine burst drains and short enough
 * that a misconfiguration (`max_rps: 0`) surfaces as slow delivery rather
 * than as a consumer that never returns.
 */
const MAX_WINDOW_WAITS = 10;
