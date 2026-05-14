/**
 * Behavioral tests for the in-memory `RateLimiter`.
 *
 * Pins:
 *
 *   - per-window counter bookkeeping (count advances on each acquire)
 *   - allowance=0 → unconditionally allowed (no-op limiter)
 *   - exceeding the allowance returns `allowed: false` with
 *     `retry_after_seconds` covering the rest of the window
 *   - window roll-over resets the counter
 *   - per-project overrides honored via `createAllowanceResolver`
 *
 * @see apps/ingester-api/src/rate-limit/memory.ts
 */

import { describe, expect, it } from "vitest";

import { createAllowanceResolver, createMemoryRateLimiter } from "../../src/rate-limit/index.js";

const input = (
  over: Partial<{ apiKeyId: string; projectId: string; environment: string }> = {},
) => ({
  apiKeyId: "polaris_key_test",
  projectId: "storefront",
  environment: "production",
  ...over,
});

describe("createMemoryRateLimiter", () => {
  it("allows requests up to the per-key allowance and refuses the (allowance+1)th", async () => {
    let now = 1_000_000;
    const limiter = createMemoryRateLimiter({
      allowanceFor: () => 3,
      windowSeconds: 1,
      now: () => now,
    });
    expect((await limiter.acquire(input())).allowed).toBe(true);
    expect((await limiter.acquire(input())).allowed).toBe(true);
    expect((await limiter.acquire(input())).allowed).toBe(true);
    const refused = await limiter.acquire(input());
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("expected refused");
    expect(refused.retry_after_seconds).toBeGreaterThanOrEqual(1);
  });

  it("treats allowance=0 as 'unlimited' (no-op limiter)", async () => {
    const limiter = createMemoryRateLimiter({
      allowanceFor: () => 0,
      windowSeconds: 1,
      now: () => 0,
    });
    for (let i = 0; i < 1000; i += 1) {
      expect((await limiter.acquire(input())).allowed).toBe(true);
    }
  });

  it("resets the counter when the window advances", async () => {
    let now = 1_000_000;
    const limiter = createMemoryRateLimiter({
      allowanceFor: () => 2,
      windowSeconds: 1,
      now: () => now,
    });
    await limiter.acquire(input());
    await limiter.acquire(input());
    expect((await limiter.acquire(input())).allowed).toBe(false);
    // Advance into the next window.
    now += 1500;
    expect((await limiter.acquire(input())).allowed).toBe(true);
  });

  it("keys per-apiKeyId so two keys don't share a bucket", async () => {
    let now = 1_000_000;
    const limiter = createMemoryRateLimiter({
      allowanceFor: () => 2,
      windowSeconds: 1,
      now: () => now,
    });
    expect((await limiter.acquire(input({ apiKeyId: "key-a" }))).allowed).toBe(true);
    expect((await limiter.acquire(input({ apiKeyId: "key-a" }))).allowed).toBe(true);
    expect((await limiter.acquire(input({ apiKeyId: "key-a" }))).allowed).toBe(false);
    expect((await limiter.acquire(input({ apiKeyId: "key-b" }))).allowed).toBe(true);
    expect((await limiter.acquire(input({ apiKeyId: "key-b" }))).allowed).toBe(true);
  });

  it("rejects windowSeconds < 1 at construction", () => {
    expect(() => createMemoryRateLimiter({ allowanceFor: () => 1, windowSeconds: 0 })).toThrow(
      /windowSeconds/,
    );
  });
});

describe("createAllowanceResolver", () => {
  it("returns the default RPS when no overrides are supplied", () => {
    const resolver = createAllowanceResolver({ defaultPerKeyRps: 1000 });
    expect(resolver(input())).toBe(1000);
  });

  it("returns a per-project override when one is configured", () => {
    const resolver = createAllowanceResolver({
      defaultPerKeyRps: 1000,
      projectOverrides: new Map([["storefront", 250]]),
    });
    expect(resolver(input({ projectId: "storefront" }))).toBe(250);
    expect(resolver(input({ projectId: "marketing" }))).toBe(1000);
  });
});
