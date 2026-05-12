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

  it("applies bidirectional jitter symmetrically around the base", () => {
    const policy = resolveRetryPolicy({
      jitterRatio: 0.5,
      initialDelayMs: 100,
      backoffMultiplier: 1,
      maxDelayMs: 1_000,
    });
    // Bidirectional jitter spreads on both sides of the deterministic
    // schedule so retries don't all cluster on the upper side.
    expect(computeBackoffMs(policy, 1, () => 1)).toBe(150); // max +
    expect(computeBackoffMs(policy, 1, () => 0.5)).toBe(100); // centered
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(50); // max -
  });

  it("clamps negative jitter to 0", () => {
    // initialDelay is small enough that max negative jitter would go
    // below zero; clamp guarantees we never sleep for a negative time.
    const policy = resolveRetryPolicy({
      jitterRatio: 2,
      initialDelayMs: 100,
      backoffMultiplier: 1,
      maxDelayMs: 1_000,
    });
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(0);
  });
});
