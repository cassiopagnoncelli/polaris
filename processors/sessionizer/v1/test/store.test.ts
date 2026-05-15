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

describe("InMemorySessionStore", () => {
  it("set/get round-trips a record", () => {
    const store = new InMemorySessionStore();
    const rec = makeRecord();
    store.set("k", rec);
    expect(store.get("k")).toEqual(rec);
  });

  it("delete removes a key", () => {
    const store = new InMemorySessionStore();
    store.set("k", makeRecord());
    store.delete("k");
    expect(store.get("k")).toBeUndefined();
  });

  it("gcExpired returns and removes records older than the inactivity window", () => {
    const store = new InMemorySessionStore();
    store.set("fresh", makeRecord({ last_seen_at: "2026-05-12T12:00:00.000Z" }));
    store.set("stale", makeRecord({ last_seen_at: "2026-05-12T11:00:00.000Z" }));
    const expired = store.gcExpired({
      inactivity_seconds: 1800,
      now: new Date("2026-05-12T12:00:00.000Z"),
    });
    expect(expired).toHaveLength(1);
    expect(expired[0]?.last_seen_at).toBe("2026-05-12T11:00:00.000Z");
    expect(store.size()).toBe(1);
    expect(store.get("fresh")).toBeDefined();
    expect(store.get("stale")).toBeUndefined();
  });

  it("size tracks the number of active records", () => {
    const store = new InMemorySessionStore();
    expect(store.size()).toBe(0);
    store.set("a", makeRecord());
    store.set("b", makeRecord({ session_id: "sess_b" }));
    expect(store.size()).toBe(2);
    store.delete("a");
    expect(store.size()).toBe(1);
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
