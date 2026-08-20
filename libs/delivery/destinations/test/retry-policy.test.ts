/**
 * `destinations.retry_policy` → a backoff schedule.
 *
 * The column has been writable, and shown by `polaris destinations show`,
 * since destinations shipped — and read by nothing. Every instance backed off
 * identically regardless of what an operator set. These pin the walk for each
 * profile so the knob is verifiably connected to something.
 */

import { RETRY_BACKOFF_TIERS_MS } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { retryDelayMsFor } from "../src/retry-policy.js";

/** The CHECK constraint's closed set, listed here so the loop below is explicit. */
const POLICIES = ["standard", "aggressive", "conservative"] as const;

const [T5S, T30S, T2M, T10M, T30M] = RETRY_BACKOFF_TIERS_MS;

function walk(policy: string, attempts = 6): number[] {
  return Array.from({ length: attempts }, (_, i) => retryDelayMsFor(policy, i + 1));
}

describe("retryDelayMsFor", () => {
  it("standard reproduces the previous hardcoded ladder", () => {
    // The property that makes this safe to start reading: an instance that
    // never set the column sees no change at the moment the value begins to
    // matter. Until this landed the ladder was not wired at all, so every
    // operator's setting is untested in production.
    expect(walk("standard")).toEqual([T5S, T30S, T2M, T10M, T30M, T30M]);
  });

  it("aggressive stays low longer, for a vendor whose 5xx are momentary", () => {
    // Four attempts inside a minute rather than spread over two and a half.
    expect(walk("aggressive")).toEqual([T5S, T5S, T30S, T30S, T2M, T2M]);
  });

  it("conservative backs off sooner, for a vendor that sheds load", () => {
    // Retrying quickly against a rate limiter is what keeps it shedding.
    expect(walk("conservative")).toEqual([T30S, T2M, T10M, T30M, T30M, T30M]);
  });

  it("only ever returns a tier that has a provisioned queue", () => {
    // The tiers are QUEUES declared by `pnpm rabbitmq:provision`, and the
    // broker owns the delay through each queue's TTL. A policy that computed
    // an arbitrary backoff would publish to a queue nobody declared.
    for (const policy of [...POLICIES, "nonsense"]) {
      for (let attempt = 1; attempt <= 12; attempt++) {
        expect(RETRY_BACKOFF_TIERS_MS).toContain(retryDelayMsFor(policy, attempt));
      }
    }
  });

  it("falls back to standard for a policy it does not recognise", () => {
    // A row written by a newer build, or hand-edited past the CHECK
    // constraint. A delivery must not fail because its backoff table is
    // unfamiliar.
    expect(walk("from-the-future")).toEqual(walk("standard"));
  });

  it("clamps a nonsense attempt number rather than throwing", () => {
    expect(retryDelayMsFor("standard", 0)).toBe(T5S);
    expect(retryDelayMsFor("standard", -3)).toBe(T5S);
    expect(retryDelayMsFor("standard", 999)).toBe(T30M);
  });
});
