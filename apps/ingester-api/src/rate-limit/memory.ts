/**
 * In-memory sliding-window rate limiter.
 *
 * Used by:
 *
 *   - unit tests that want deterministic counter behavior without
 *     a Redis stub,
 *   - local dev when `POLARIS_REDIS_HOST` is unset (host falls back to
 *     in-memory so single-node operation stays self-contained),
 *   - integration tests that drive `/v1/events` through the route
 *     preHandler and assert 429 + Retry-After.
 *
 * The counter bookkeeping is exactly the Redis adapter's semantics
 * (bucket = floor(now / windowSec), counter resets per bucket, TTL
 * elapses automatically) but with no I/O — perfect for tests.
 */

import { DEFAULT_RATE_LIMIT_WINDOW_SECONDS, type RateLimitAllowanceResolver } from "./redis.js";
import type { RateLimitAcquireInput, RateLimitDecision, RateLimiter } from "./types.js";

export interface CreateMemoryRateLimiterOptions {
  /** Allowance resolver per acquire. */
  readonly allowanceFor: RateLimitAllowanceResolver;
  /** Sliding window length in seconds. Defaults to 1. */
  readonly windowSeconds?: number;
  /** Override `Date.now` for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Build an in-memory `RateLimiter`. The state lives in the closure; one
 * limiter per host (NOT shared across Fastify instances).
 */
export function createMemoryRateLimiter(options: CreateMemoryRateLimiterOptions): RateLimiter {
  const windowSeconds = options.windowSeconds ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS;
  const now = options.now ?? Date.now;
  if (windowSeconds < 1) {
    throw new RangeError("windowSeconds must be >= 1");
  }

  // Map keyed on `<apiKeyId>:<bucket>` -> count.
  const buckets = new Map<string, number>();

  async function acquire(input: RateLimitAcquireInput): Promise<RateLimitDecision> {
    const allowance = options.allowanceFor(input);
    if (allowance <= 0) return { allowed: true };

    const nowMs = now();
    const bucket = Math.floor(nowMs / 1000 / windowSeconds);
    const key = `${input.apiKeyId}:${bucket}`;

    // Lazy eviction: when this is the first hit on a new bucket index
    // for this apiKeyId, drop the prior bucket (if any). The map stays
    // bounded at one entry per apiKeyId plus stragglers from racing
    // calls — adequate for tests.
    if (!buckets.has(key)) {
      for (const existing of buckets.keys()) {
        const dash = existing.lastIndexOf(":");
        if (dash === -1) continue;
        const otherKey = existing.slice(0, dash);
        const otherBucket = Number.parseInt(existing.slice(dash + 1), 10);
        if (otherKey === input.apiKeyId && otherBucket < bucket) {
          buckets.delete(existing);
        }
      }
    }

    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    if (count > allowance) {
      const remainingSec = Math.max(
        1,
        Math.ceil(((bucket + 1) * windowSeconds * 1000 - nowMs) / 1000),
      );
      return { allowed: false, retry_after_seconds: remainingSec };
    }
    return { allowed: true };
  }

  return { acquire };
}
