/**
 * Redis-backed session-store tests (ADR 0005).
 *
 * Driven through a fake client rather than a live Redis: the contract
 * worth pinning here is what the store does with what Redis returns —
 * TTL arming, absent-vs-corrupt handling, and the failure policy that
 * distinguishes this store from the ingester's dedupe store.
 */

import { describe, expect, it, vi } from "vitest";

import { createRedisSessionStore, type RedisClientLike, sessionKey } from "../src/redis-store.js";
import type { SessionRecord } from "../src/transform.js";

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session_id: "sess_abc",
    project_id: "checkout",
    environment: "production",
    primary_identifier_kind: "anonymous_id",
    primary_identifier_value: "anon_X",
    started_at: "2026-05-12T12:00:00.000Z",
    last_seen_at: "2026-05-12T12:00:00.000Z",
    event_count: 1,
    source_event_id: "evt_1",
    ...overrides,
  };
}

interface FakeRedis extends RedisClientLike {
  readonly store: Map<string, string>;
  readonly sets: Array<{ key: string; ttl: number }>;
}

function fakeRedis(overrides: Partial<RedisClientLike> = {}): FakeRedis {
  const store = new Map<string, string>();
  const sets: Array<{ key: string; ttl: number }> = [];
  return {
    store,
    sets,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, _mode, ttl) {
      store.set(key, value);
      sets.push({ key, ttl });
      return "OK";
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    ...overrides,
  } as FakeRedis;
}

function storeWith(client: RedisClientLike, opTimeoutMs = 250) {
  return createRedisSessionStore({ client, keyPrefix: "polaris:session", opTimeoutMs });
}

describe("RedisSessionStore", () => {
  it("round-trips a record through the namespaced key", async () => {
    const client = fakeRedis();
    const store = storeWith(client);
    const record = makeRecord();

    await store.set("checkout::production::anonymous_id:anon_X", record, 1800);
    expect(client.store.has("polaris:session:checkout::production::anonymous_id:anon_X")).toBe(
      true,
    );
    expect(await store.get("checkout::production::anonymous_id:anon_X")).toEqual(record);
  });

  it("arms the inactivity window as the key TTL", async () => {
    const client = fakeRedis();
    await storeWith(client).set("k", makeRecord(), 1800);
    expect(client.sets[0]?.ttl).toBe(1800);
  });

  it("floors the TTL at one second, since Redis rejects a non-positive EX", async () => {
    const client = fakeRedis();
    await storeWith(client).set("k", makeRecord(), 0);
    expect(client.sets[0]?.ttl).toBe(1);
  });

  it("reads an absent key as no session", async () => {
    expect(await storeWith(fakeRedis()).get("missing")).toBeUndefined();
  });

  it("treats a corrupt value as absent rather than throwing", async () => {
    // Throwing would pin the partition on a value no redelivery can fix.
    // Reading it as absent opens a fresh session, which is what expiry
    // would have produced anyway.
    const client = fakeRedis();
    client.store.set(sessionKey("polaris:session", "k"), "{not json");
    expect(await storeWith(client).get("k")).toBeUndefined();
  });

  it("treats a structurally incomplete record as absent", async () => {
    const client = fakeRedis();
    client.store.set(sessionKey("polaris:session", "k"), JSON.stringify({ session_id: "s" }));
    expect(await storeWith(client).get("k")).toBeUndefined();
  });

  it("propagates a Redis failure instead of swallowing it", async () => {
    // The opposite of the ingester's dedupe store on purpose: without the
    // prior record the sessionizer cannot tell a continuation from a new
    // session, and guessing would mint a wrong session_id. Failing means
    // the checkpoint does not advance and the message is redelivered.
    const client = fakeRedis({
      async get() {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(storeWith(client).get("k")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("propagates a write failure too", async () => {
    const client = fakeRedis({
      async set() {
        throw new Error("READONLY");
      },
    });
    await expect(storeWith(client).set("k", makeRecord(), 1800)).rejects.toThrow(/READONLY/);
  });

  it("times out a hung Redis rather than hanging the handler", async () => {
    const client = fakeRedis({
      get: () => new Promise<string | null>(() => undefined),
    });
    await expect(storeWith(client, 10).get("k")).rejects.toThrow(/redis_get_timeout/);
  });

  it("tracks health from the client event stream", async () => {
    const listeners = new Map<string, (err?: unknown) => void>();
    const client = fakeRedis({
      on(event, listener) {
        listeners.set(event, listener);
        return undefined;
      },
    });
    const store = storeWith(client);

    expect(store.isHealthy()).toBe(false);
    listeners.get("connect")?.();
    expect(store.isHealthy()).toBe(true);
    listeners.get("error")?.(new Error("boom"));
    expect(store.isHealthy()).toBe(false);
    listeners.get("ready")?.();
    expect(store.isHealthy()).toBe(true);
    listeners.get("end")?.();
    expect(store.isHealthy()).toBe(false);
  });

  it("closes the underlying client", async () => {
    const quit = vi.fn(async () => undefined);
    await storeWith(fakeRedis({ quit })).close();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("swallows a close error, since shutdown must not fail on it", async () => {
    const client = fakeRedis({
      async quit() {
        throw new Error("already closed");
      },
    });
    await expect(storeWith(client).close()).resolves.toBeUndefined();
  });
});
