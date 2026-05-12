import { describe, expect, it } from "vitest";

import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  resolveRetryPolicy,
} from "../src/internal/retry.js";

describe("retry policy", () => {
  it("resolves to defaults when nothing is passed", () => {
    expect(resolveRetryPolicy(undefined)).toStrictEqual(DEFAULT_RETRY_POLICY);
  });

  it("merges partial overrides", () => {
    const policy = resolveRetryPolicy({ maxAttempts: 7 });
    expect(policy.maxAttempts).toBe(7);
    expect(policy.initialDelayMs).toBe(DEFAULT_RETRY_POLICY.initialDelayMs);
    expect(policy.jitterRatio).toBe(DEFAULT_RETRY_POLICY.jitterRatio);
  });

  it("computes exponential backoff", () => {
    // Zero jitter so we can assert deterministic delays.
    const policy = resolveRetryPolicy({
      jitterRatio: 0,
      initialDelayMs: 100,
      backoffMultiplier: 2,
    });
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(100);
    expect(computeBackoffMs(policy, 2, () => 0)).toBe(200);
    expect(computeBackoffMs(policy, 3, () => 0)).toBe(400);
  });

  it("caps at maxDelayMs", () => {
    const policy = resolveRetryPolicy({
      jitterRatio: 0,
      initialDelayMs: 1_000,
      backoffMultiplier: 10,
      maxDelayMs: 5_000,
    });
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(1_000);
    expect(computeBackoffMs(policy, 2, () => 0)).toBe(5_000);
    expect(computeBackoffMs(policy, 5, () => 0)).toBe(5_000);
  });

  it("applies jitter as a non-negative fraction", () => {
    const policy = resolveRetryPolicy({
      jitterRatio: 0.5,
      initialDelayMs: 100,
      backoffMultiplier: 1,
      maxDelayMs: 1_000,
    });
    // randomFn returns 1 → max jitter
    expect(computeBackoffMs(policy, 1, () => 1)).toBe(150);
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(100);
  });
});
