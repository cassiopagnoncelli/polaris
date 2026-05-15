import { describe, expect, it } from "vitest";

import { VaultSecretCache } from "../src/providers/vault-cache.js";

/**
 * Sentinel value asserted absent from any error output. The cache exposes no
 * error surface beyond constructor validation, so the relevant guard is that
 * `peek`/diagnostic methods never return the value.
 */
const SECRET_VALUE = "tk_super_secret_should_not_leak";

class FakeClock {
  public t = 0;
  public now(): number {
    return this.t;
  }
}

describe("VaultSecretCache", () => {
  it("returns the cached value before the TTL elapses", () => {
    const clock = new FakeClock();
    const cache = new VaultSecretCache({ ttlMs: 1000, clock });
    cache.set("polaris/prod/p/x", SECRET_VALUE);
    expect(cache.get("polaris/prod/p/x")).toBe(SECRET_VALUE);
    clock.t += 999;
    expect(cache.get("polaris/prod/p/x")).toBe(SECRET_VALUE);
  });

  it("returns undefined on the fresh path once the TTL has elapsed", () => {
    const clock = new FakeClock();
    const cache = new VaultSecretCache({ ttlMs: 1000, clock });
    cache.set("polaris/prod/p/x", SECRET_VALUE);
    clock.t += 1000; // expiresAt is inclusive (<=); equal means expired
    expect(cache.get("polaris/prod/p/x")).toBeUndefined();
    clock.t += 1;
    expect(cache.get("polaris/prod/p/x")).toBeUndefined();
  });

  it("still returns expired entries via getStale", () => {
    const clock = new FakeClock();
    const cache = new VaultSecretCache({ ttlMs: 1000, clock });
    cache.set("polaris/prod/p/x", SECRET_VALUE);
    clock.t += 10_000; // far past expiry
    expect(cache.get("polaris/prod/p/x")).toBeUndefined();
    expect(cache.getStale("polaris/prod/p/x")).toBe(SECRET_VALUE);
  });

  it("returns undefined from getStale when the ref was never cached", () => {
    const cache = new VaultSecretCache({ ttlMs: 1000 });
    expect(cache.getStale("never/seen")).toBeUndefined();
  });

  it("overwrites the existing entry on set and resets the TTL", () => {
    const clock = new FakeClock();
    const cache = new VaultSecretCache({ ttlMs: 1000, clock });
    cache.set("k", "v1");
    clock.t += 500;
    cache.set("k", "v2");
    // Original would now be 500ms in, fresh entry has full 1000ms ahead.
    clock.t += 800; // total 1300ms — original would be expired, fresh isn't.
    expect(cache.get("k")).toBe("v2");
  });

  it("evicts a specific entry via delete", () => {
    const cache = new VaultSecretCache({ ttlMs: 1000 });
    cache.set("k", SECRET_VALUE);
    cache.delete("k");
    expect(cache.get("k")).toBeUndefined();
    expect(cache.getStale("k")).toBeUndefined();
  });

  it("supports ttlMs=0 (caching effectively disabled)", () => {
    const clock = new FakeClock();
    const cache = new VaultSecretCache({ ttlMs: 0, clock });
    cache.set("k", SECRET_VALUE);
    // expiresAt = now + 0 = now, and `<=` is the expiry test, so we get undefined immediately.
    expect(cache.get("k")).toBeUndefined();
    // The entry is still there for stale-serving though.
    expect(cache.getStale("k")).toBe(SECRET_VALUE);
  });

  it("rejects negative or non-finite ttlMs", () => {
    expect(() => new VaultSecretCache({ ttlMs: -1 })).toThrow(TypeError);
    expect(() => new VaultSecretCache({ ttlMs: Number.NaN })).toThrow(TypeError);
    expect(() => new VaultSecretCache({ ttlMs: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("peek returns metadata without leaking the value through diagnostics", () => {
    const clock = new FakeClock();
    clock.t = 1_000;
    const cache = new VaultSecretCache({ ttlMs: 5_000, clock });
    cache.set("k", SECRET_VALUE);
    const peeked = cache.peek("k");
    expect(peeked).toEqual({ fetchedAt: 1_000, expiresAt: 6_000 });
    // The peek result shape should not have a `value` field — assert it.
    expect(JSON.stringify(peeked)).not.toContain(SECRET_VALUE);
  });

  it("clear drops every entry", () => {
    const cache = new VaultSecretCache({ ttlMs: 1000 });
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
