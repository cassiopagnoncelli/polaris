/**
 * In-memory session-store tests for sessionizer v1.
 */

import { describe, expect, it } from "vitest";

import { buildContinuedRecord, buildOpenedRecord, InMemorySessionStore } from "../src/store.js";
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

const TTL = 1800;

describe("InMemorySessionStore", () => {
  it("set/get round-trips a record", async () => {
    const store = new InMemorySessionStore();
    const rec = makeRecord();
    await store.set("k", rec, TTL);
    expect(await store.get("k")).toEqual(rec);
  });

  it("delete removes a key", async () => {
    const store = new InMemorySessionStore();
    await store.set("k", makeRecord(), TTL);
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("expires a record once its TTL elapses", async () => {
    // Redis-equivalent semantics: a key past its TTL reads as absent.
    // The in-memory adapter must model this or every test passes against
    // behaviour production does not have.
    let clock = 1_000_000;
    const store = new InMemorySessionStore({ now: () => clock });
    await store.set("k", makeRecord(), TTL);

    clock += TTL * 1000 - 1;
    expect(await store.get("k")).toBeDefined();

    clock += 1;
    expect(await store.get("k")).toBeUndefined();
  });

  it("re-arms the TTL on every write, so an active session survives", async () => {
    let clock = 1_000_000;
    const store = new InMemorySessionStore({ now: () => clock });
    await store.set("k", makeRecord(), TTL);

    // Write again just before expiry — the window restarts from here.
    clock += TTL * 1000 - 1;
    await store.set("k", makeRecord({ event_count: 2 }), TTL);

    clock += TTL * 1000 - 1;
    expect((await store.get("k"))?.event_count).toBe(2);
  });

  it("size and snapshot count only live records", async () => {
    let clock = 1_000_000;
    const store = new InMemorySessionStore({ now: () => clock });
    expect(store.size()).toBe(0);
    await store.set("a", makeRecord(), TTL);
    await store.set("b", makeRecord({ session_id: "sess_b" }), TTL);
    expect(store.size()).toBe(2);
    expect(store.snapshot()).toHaveLength(2);

    await store.delete("a");
    expect(store.size()).toBe(1);

    clock += TTL * 1000 + 1;
    expect(store.size()).toBe(0);
    expect(store.snapshot()).toHaveLength(0);
  });
});

describe("buildContinuedRecord", () => {
  it("bumps event_count and last_seen_at while preserving session_id and started_at", () => {
    const prior = makeRecord({ event_count: 5, last_seen_at: "2026-05-12T11:55:00.000Z" });
    const next = buildContinuedRecord({
      prior,
      raw_event_id: "evt_new",
      raw_occurred_at: "2026-05-12T12:00:00.000Z",
    });
    expect(next.session_id).toBe(prior.session_id);
    expect(next.started_at).toBe(prior.started_at);
    expect(next.event_count).toBe(6);
    expect(next.last_seen_at).toBe("2026-05-12T12:00:00.000Z");
    // source_event_id sticks to the original event that opened the session.
    expect(next.source_event_id).toBe(prior.source_event_id);
  });
});

describe("buildOpenedRecord", () => {
  it("starts a fresh record with event_count 1 and last_seen_at equal to started_at", () => {
    const opened = buildOpenedRecord({
      session_id: "sess_new",
      project_id: "checkout",
      environment: "production",
      primary_identifier_kind: "anonymous_id",
      primary_identifier_value: "anon_X",
      started_at: "2026-05-12T12:00:00.000Z",
      source_event_id: "evt_1",
    });
    expect(opened.event_count).toBe(1);
    expect(opened.last_seen_at).toBe(opened.started_at);
    expect(opened.session_id).toBe("sess_new");
  });
});
