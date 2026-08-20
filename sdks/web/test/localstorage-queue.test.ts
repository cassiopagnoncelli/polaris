// @vitest-environment happy-dom
/**
 * `LocalStorageQueue` — fallback when IndexedDB is unavailable.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * localStorage queue tests assert:
 *
 *   - persistence via a single JSON-encoded key (atomic write)
 *   - FIFO drain within priority
 *   - priority-based overflow eviction
 *   - corrupt-payload tolerance (cross-version SDK that wrote a different
 *     shape) — the queue treats it as empty rather than crashing
 */

import { beforeEach, describe, expect, it } from "vitest";

import { LocalStorageQueue } from "../src/queue/localstorage-queue.js";
import type { EventPriority, QueueEntry } from "../src/types.js";

function entry(idSuffix: string, priority: EventPriority = "normal"): QueueEntry {
  return {
    payload: {
      event_id: `00000000-0000-7000-8000-${idSuffix.padStart(12, "0")}`,
      event: "test.event",
      schema_version: 1,
      occurred_at: new Date(1).toISOString(),
      source: { type: "browser", id: "test", sdk: "web", sdk_version: "0.0.0" },
      identity: { anonymous_id: "a", session_id: "s", customer_id: null, device_id: null },
      context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
      properties: {},
    },
    priority,
    attempts: 0,
    enqueued_at: 1,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("LocalStorageQueue", () => {
  it("requires storage", () => {
    expect(() => new LocalStorageQueue({ storage: undefined, maxSize: 10 })).toThrowError(
      /storage/,
    );
  });

  it("persists entries to localStorage and survives a fresh queue instance", async () => {
    const q1 = new LocalStorageQueue({ storage: window.localStorage, maxSize: 10 });
    await q1.enqueue(entry("01"));
    await q1.enqueue(entry("02"));
    // Construct a brand-new queue against the same storage — simulates
    // page reload. Entries should still be visible.
    const q2 = new LocalStorageQueue({ storage: window.localStorage, maxSize: 10 });
    expect(await q2.size()).toBe(2);
    const drained = await q2.drainAll();
    expect(drained.map((e) => e.payload.event_id.slice(-2))).toEqual(["01", "02"]);
  });

  it("drains FIFO and shrinks the persisted record", async () => {
    const q = new LocalStorageQueue({ storage: window.localStorage, maxSize: 10 });
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    await q.enqueue(entry("03"));
    const drained = await q.drain(2);
    expect(drained.length).toBe(2);
    expect(await q.size()).toBe(1);
  });

  it("evicts oldest-low under overflow and emits the dropped event", async () => {
    const q = new LocalStorageQueue({ storage: window.localStorage, maxSize: 3 });
    await q.enqueue(entry("01", "low"));
    await q.enqueue(entry("02", "high"));
    await q.enqueue(entry("03", "normal"));
    const result = await q.enqueue(entry("04", "normal"));
    expect(result.status).toBe("accepted_with_drops");
    if (result.status === "accepted_with_drops") {
      expect(result.dropped[0]?.payload.event_id.slice(-2)).toBe("01");
    }
  });

  it("rejects when nothing can be evicted", async () => {
    const q = new LocalStorageQueue({ storage: window.localStorage, maxSize: 2 });
    await q.enqueue(entry("01", "high"));
    await q.enqueue(entry("02", "high"));
    const result = await q.enqueue(entry("03", "low"));
    expect(result.status).toBe("rejected");
  });

  it("treats a corrupt payload as empty (fall-forward, do not crash)", async () => {
    window.localStorage.setItem("polaris_queue", "not-json-at-all");
    const q = new LocalStorageQueue({ storage: window.localStorage, maxSize: 10 });
    expect(await q.size()).toBe(0);
    await q.enqueue(entry("01"));
    expect(await q.size()).toBe(1);
  });

  it("requeue preserves event_id at the head", async () => {
    const q = new LocalStorageQueue({ storage: window.localStorage, maxSize: 10 });
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    const drained = await q.drain(2);
    await q.enqueue(entry("03"));
    await q.requeue(drained);
    const drainedAgain = await q.drainAll();
    expect(drainedAgain.map((e) => e.payload.event_id)).toEqual([
      drained[0]?.payload.event_id,
      drained[1]?.payload.event_id,
      // 03 came after, so it sits last
      `00000000-0000-7000-8000-000000000003`,
    ]);
  });
});
