/**
 * The per-instance circuit breaker.
 *
 * Its job is not to save the vendor — it is to stop spending the consumer's
 * capacity on a destination that is answering "no" to everything, so the
 * other destinations in the same process keep flowing.
 */

import { describe, expect, it } from "vitest";

import { breakerKey, DestinationCircuitBreaker } from "../src/breaker.js";

const KEY = breakerKey("polaris_dst_1", "production");

function make(nowRef: { ms: number }, failureThreshold = 3, cooldownMs = 30_000) {
  return new DestinationCircuitBreaker({
    failureThreshold,
    cooldownMs,
    now: () => nowRef.ms,
  });
}

describe("circuit breaker", () => {
  it("stays closed below the threshold", () => {
    const now = { ms: 0 };
    const breaker = make(now);
    breaker.onFailure(KEY);
    breaker.onFailure(KEY);
    expect(breaker.check(KEY)).toEqual({ allowed: true, state: "closed" });
  });

  it("trips on consecutive failures and refuses without a network call", () => {
    const now = { ms: 0 };
    const breaker = make(now);
    for (let i = 0; i < 3; i++) breaker.onFailure(KEY);

    const decision = breaker.check(KEY);
    expect(decision.allowed).toBe(false);
    expect(decision.state).toBe("open");
    expect(decision.retryAfterMs).toBe(30_000);
  });

  it("resets the count on any success", () => {
    // A breaker that tripped on N failures spread across an hour of healthy
    // traffic would be measuring the wrong thing.
    const now = { ms: 0 };
    const breaker = make(now);
    breaker.onFailure(KEY);
    breaker.onFailure(KEY);
    breaker.onSuccess(KEY);
    breaker.onFailure(KEY);
    breaker.onFailure(KEY);
    expect(breaker.check(KEY).allowed).toBe(true);
  });

  it("admits exactly one probe when the cooldown lapses", () => {
    // Several probes at once would send a burst at a vendor that has just
    // started answering — how a recovering service gets knocked over twice.
    const now = { ms: 0 };
    const breaker = make(now);
    for (let i = 0; i < 3; i++) breaker.onFailure(KEY);
    now.ms += 30_000;

    expect(breaker.check(KEY)).toEqual({ allowed: true, state: "half_open" });
    expect(breaker.check(KEY).allowed).toBe(false);
  });

  it("a successful probe closes the breaker outright", () => {
    const now = { ms: 0 };
    const breaker = make(now);
    for (let i = 0; i < 3; i++) breaker.onFailure(KEY);
    now.ms += 30_000;
    breaker.check(KEY);
    breaker.onSuccess(KEY);

    expect(breaker.stateOf(KEY)).toBe("closed");
    expect(breaker.check(KEY).allowed).toBe(true);
  });

  it("a failed probe reopens for a full cooldown", () => {
    const now = { ms: 0 };
    const breaker = make(now);
    for (let i = 0; i < 3; i++) breaker.onFailure(KEY);
    now.ms += 30_000;
    breaker.check(KEY);
    expect(breaker.onFailure(KEY)).toBe("open");

    // Not one failure away from tripping again — a full cooldown from now.
    now.ms += 29_999;
    expect(breaker.check(KEY).allowed).toBe(false);
    now.ms += 1;
    expect(breaker.check(KEY).allowed).toBe(true);
  });

  it("scopes per destination instance and environment", () => {
    // One instance being down says nothing about another instance of the
    // same vendor pointed at a different account.
    const now = { ms: 0 };
    const breaker = make(now);
    for (let i = 0; i < 3; i++) breaker.onFailure(KEY);

    expect(breaker.check(breakerKey("polaris_dst_2", "production")).allowed).toBe(true);
    expect(breaker.check(breakerKey("polaris_dst_1", "staging")).allowed).toBe(true);
  });

  it("reports state for metrics and the CLI", () => {
    const now = { ms: 0 };
    const breaker = make(now);
    for (let i = 0; i < 3; i++) breaker.onFailure(KEY);
    expect(breaker.snapshot()).toEqual([{ key: KEY, state: "open", consecutiveFailures: 3 }]);
  });
});
