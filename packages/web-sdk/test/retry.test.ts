/**
 * Retry policy with exponential backoff + jitter for the Web SDK.
 *
 * Mirrors the Node SDK retry tests in spirit — the helper is the same
 * shape but lives in the Web SDK package to avoid pulling Node-only code
 * into a browser bundle.
 */

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

  it("default maxRetries matches the architecture doc (3)", () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
  });

  it("merges partial overrides", () => {
    const policy = resolveRetryPolicy({ maxRetries: 7 });
    expect(policy.maxRetries).toBe(7);
    expect(policy.initialDelayMs).toBe(DEFAULT_RETRY_POLICY.initialDelayMs);
  });

  it("computes exponential backoff", () => {
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
    expect(computeBackoffMs(policy, 1, () => 1)).toBe(150);
    expect(computeBackoffMs(policy, 1, () => 0.5)).toBe(100);
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(50);
  });
});
