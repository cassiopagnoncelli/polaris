/**
 * Behavioral tests for the Redis-backed `RateLimiter`.
 *
 * The Redis client is stubbed structurally (we don't bring up ioredis in
 * unit tests). Pins:
 *
 *   - INCR is called per acquire with the bucket-shaped key
 *   - EXPIRE is called only on the first INCR (count===1)
 *   - exceeding the allowance returns `allowed: false` with Retry-After
 *   - Redis throw → fail-open + `polaris_ingest_rate_limit_skipped_total`
 *     increments
 *   - allowance=0 → unconditionally allowed and SKIPS Redis (hot path)
 *
 * @see apps/ingester-api/src/rate-limit/redis.ts
 */

import { describe, expect, it } from "vitest";

import {
  IngestMetrics,
  METRIC_INGEST_RATE_LIMIT_SKIPPED_TOTAL,
} from "../../src/metrics/registry.js";
import {
  createRedisRateLimiter,
  DEFAULT_RATE_LIMIT_KEY_PREFIX,
  type RateLimitRedisClient,
} from "../../src/rate-limit/index.js";

function makeClient(): {
  client: RateLimitRedisClient;
  calls: Array<{ op: "incr" | "expire"; key: string; arg?: number }>;
  setIncrThrows(err: unknown): void;
  setNextCount(n: number): void;
} {
  const calls: Array<{ op: "incr" | "expire"; key: string; arg?: number }> = [];
  let queuedThrow: unknown;
  let nextCount: number | null = null;
  let observedCount = 0;
  return {
    calls,
    setIncrThrows(err) {
      queuedThrow = err;
    },
    setNextCount(n) {
      nextCount = n;
    },
    client: {
      incr: async (key) => {
        if (queuedThrow !== undefined) {
          const err = queuedThrow;
          queuedThrow = undefined;
          throw err;
        }
        observedCount += 1;
        const count = nextCount ?? observedCount;
        calls.push({ op: "incr", key, arg: count });
        return count;
      },
      expire: async (key, ttlSec) => {
        calls.push({ op: "expire", key, arg: ttlSec });
        return 1;
      },
    },
  };
}

const input = () => ({
  apiKeyId: "polaris_key_redis",
  projectId: "storefront",
  environment: "production",
});

describe("createRedisRateLimiter", () => {
  it("INCRs the bucket key and EXPIREs only on the first hit", async () => {
    const harness = makeClient();
    const metrics = new IngestMetrics();
    const limiter = createRedisRateLimiter({
      client: harness.client,
      allowanceFor: () => 100,
      metrics,
      windowSeconds: 1,
      now: () => 1_700_000_000_000, // fixed bucket
    });
    await limiter.acquire(input());
    await limiter.acquire(input());

    const incrs = harness.calls.filter((c) => c.op === "incr");
    expect(incrs).toHaveLength(2);
    expect(incrs[0]?.key.startsWith(`${DEFAULT_RATE_LIMIT_KEY_PREFIX}:polaris_key_redis:`)).toBe(
      true,
    );

    // EXPIRE fires only when count===1 (the first hit). Subsequent hits do
    // not re-EXPIRE the key.
    const expires = harness.calls.filter((c) => c.op === "expire");
    expect(expires).toHaveLength(1);
    expect(expires[0]?.arg).toBe(2); // windowSeconds * 2
  });

  it("returns failed when the count exceeds the allowance, with retry_after_seconds >= 1", async () => {
    const harness = makeClient();
    harness.setNextCount(11);
    const metrics = new IngestMetrics();
    const limiter = createRedisRateLimiter({
      client: harness.client,
      allowanceFor: () => 10,
      metrics,
      windowSeconds: 1,
      now: () => 1_700_000_000_500,
    });
    const result = await limiter.acquire(input());
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected refused");
    expect(result.retry_after_seconds).toBeGreaterThanOrEqual(1);
  });

  it("fails OPEN on Redis throw and emits the skipped metric", async () => {
    const harness = makeClient();
    harness.setIncrThrows(new Error("ECONNREFUSED"));
    const metrics = new IngestMetrics();
    const limiter = createRedisRateLimiter({
      client: harness.client,
      allowanceFor: () => 10,
      metrics,
      now: () => 1_700_000_000_000,
    });
    const result = await limiter.acquire(input());
    expect(result.allowed).toBe(true);
    expect(
      metrics.getCounter(METRIC_INGEST_RATE_LIMIT_SKIPPED_TOTAL, {
        project_id: "storefront",
        environment: "production",
      }),
    ).toBe(1);
  });

  it("allowance=0 is the hot-path no-op (no Redis call)", async () => {
    const harness = makeClient();
    const metrics = new IngestMetrics();
    const limiter = createRedisRateLimiter({
      client: harness.client,
      allowanceFor: () => 0,
      metrics,
    });
    const result = await limiter.acquire(input());
    expect(result.allowed).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects windowSeconds < 1 at construction", () => {
    expect(() =>
      createRedisRateLimiter({
        client: makeClient().client,
        allowanceFor: () => 1,
        windowSeconds: 0,
        metrics: new IngestMetrics(),
      }),
    ).toThrow(/windowSeconds/);
  });
});
