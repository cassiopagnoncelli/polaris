/**
 * Redis-backed sliding-window rate limiter.
 *
 * Per `docs/architecture/11-production-readiness.md` and the dedupe
 * pattern in `../dedupe/redis.ts`:
 *
 *   - Bucket key is `<prefix>:<api_key_id>:<floor(now / windowSec)>`.
 *     The bucket index advances every `windowSec` seconds, so traffic
 *     in `[bucket * window, bucket * window + window)` shares a counter.
 *   - The limiter `INCR`s the bucket; on the FIRST increment it
 *     `EXPIRE`s the key to `windowSec * 2` so the bucket auto-evicts.
 *     The doubled TTL leaves slack for clock skew between client/server
 *     across the window boundary.
 *   - When the counter exceeds the per-window allowance, the limiter
 *     returns `allowed: false` with `retry_after_seconds = remaining
 *     window seconds (rounded up)`. The guard surfaces that as a
 *     `Retry-After` header on the 429 response.
 *   - Any Redis error (timeout, connection drop, command failure)
 *     produces `allowed: true` (fail-open) and increments
 *     `polaris_ingest_rate_limit_skipped_total{project_id,
 *     environment}`. Polaris prefers letting traffic through to
 *     refusing legitimate requests when the limiter subsystem is down.
 */

import type { Logger } from "@polaris/observability-logger";

import type { IngestMetrics } from "../metrics/registry.js";
import type { RateLimitAcquireInput, RateLimitDecision, RateLimiter } from "./types.js";

/**
 * Minimum Redis client surface used by the limiter. Declared structurally
 * so tests can pass a fake without importing `ioredis`. In production we
 * pass the same `ioredis` instance the dedupe store uses.
 */
export interface RateLimitRedisClient {
  incr(key: string): Promise<number>;
  expire(key: string, ttlSec: number): Promise<number | "OK">;
}

/**
 * Resolve the per-`apiKeyId` allowance for one request. Production wires
 * a function backed by `(perApiKeyRps, perProjectOverrides)`; tests pass
 * a constant. The resolver is sync because the limiter is on the hot
 * path; per-key state must come from in-process config, not a remote
 * lookup.
 */
export type RateLimitAllowanceResolver = (input: RateLimitAcquireInput) => number;

export interface CreateRedisRateLimiterOptions {
  readonly client: RateLimitRedisClient;
  /** Key prefix; mirrors dedupe shape. Defaults to `polaris:ingest:rl`. */
  readonly keyPrefix?: string;
  /** Sliding window length in seconds. Defaults to 1 (per-second RPS). */
  readonly windowSeconds?: number;
  /** Allowance resolver per acquire. */
  readonly allowanceFor: RateLimitAllowanceResolver;
  /** Op timeout in milliseconds. 0 disables the timeout. Defaults to 50. */
  readonly opTimeoutMs?: number;
  /** Metrics sink for fail-open accounting. */
  readonly metrics: IngestMetrics;
  /** Optional logger for warn-level fail-open events. */
  readonly logger?: Logger;
  /** Override `Date.now` for deterministic tests. */
  readonly now?: () => number;
}

/** Default key prefix; mirrors `dedupe`. */
export const DEFAULT_RATE_LIMIT_KEY_PREFIX = "polaris:ingest:rl" as const;

/** Default window length: 1 second (per-RPS bucket). */
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 1 as const;

/** Default op timeout in milliseconds. */
export const DEFAULT_RATE_LIMIT_OP_TIMEOUT_MS = 50 as const;

/**
 * Build a Redis-backed `RateLimiter`. The result is safe to share across
 * the whole Fastify process — no per-request state is captured.
 */
export function createRedisRateLimiter(options: CreateRedisRateLimiterOptions): RateLimiter {
  const {
    client,
    keyPrefix = DEFAULT_RATE_LIMIT_KEY_PREFIX,
    windowSeconds = DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    allowanceFor,
    opTimeoutMs = DEFAULT_RATE_LIMIT_OP_TIMEOUT_MS,
    metrics,
    logger,
    now = Date.now,
  } = options;

  if (windowSeconds < 1) {
    throw new RangeError("windowSeconds must be >= 1");
  }

  async function acquire(input: RateLimitAcquireInput): Promise<RateLimitDecision> {
    const allowance = allowanceFor(input);
    // An allowance of <=0 means "unlimited" — Polaris uses this for
    // bootstrap / smoke tests. The hot path stays fast: no Redis call.
    if (allowance <= 0) return { allowed: true };

    const nowMs = now();
    const bucket = Math.floor(nowMs / 1000 / windowSeconds);
    const key = `${keyPrefix}:${input.apiKeyId}:${bucket}`;
    try {
      const count = await withTimeout(client.incr(key), opTimeoutMs, "redis_incr_timeout");
      if (count === 1) {
        // Set TTL on first increment. Doubled to absorb clock skew
        // between client/server across the window boundary.
        await withTimeout(
          Promise.resolve(client.expire(key, windowSeconds * 2)),
          opTimeoutMs,
          "redis_expire_timeout",
        ).catch(() => undefined);
      }
      if (count > allowance) {
        const remainingSec = Math.max(
          1,
          Math.ceil(((bucket + 1) * windowSeconds * 1000 - nowMs) / 1000),
        );
        return { allowed: false, retry_after_seconds: remainingSec };
      }
      return { allowed: true };
    } catch (err) {
      metrics.incrementRateLimitSkipped({
        project_id: input.projectId,
        environment: input.environment,
      });
      logger?.warn(
        {
          component: "ingest.rate_limit",
          err: errSummary(err),
          key_prefix: keyPrefix,
        },
        "redis rate-limit acquire failed; failing open",
      );
      return { allowed: true };
    }
  }

  return { acquire };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
