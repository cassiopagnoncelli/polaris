// @vitest-environment happy-dom
/**
 * `IndexedDbQueue` — preferred queue layer.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * happy-dom does NOT ship IndexedDB. We use the `fake-indexeddb` package
 * to exercise the queue against a Node-friendly IDBFactory that
 * implements the W3C IndexedDB spec. Real browsers run the same code
 * path against the native implementation — the only difference is the
 * factory wiring.
 *
 * Tests cover:
 *
 *   - happy-path enqueue / drain / drainAll
 *   - persistence across queue instances (simulating a tab reload)
 *   - priority-based overflow eviction
 *   - requeue preserves event_id for retry
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { IndexedDbQueue, probeIndexedDb } from "../src/queue/indexeddb-queue.js";
import type { EventPriority, QueueEntry } from "../src/types.js";

let factory: IDBFactory;
let counter = 0;

beforeEach(() => {
  // Each test gets a fresh factory so DB state doesn't leak across tests.
  factory = new IDBFactory();
  counter += 1;
});

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

function makeQueue(maxSize: number): IndexedDbQueue {
  return new IndexedDbQueue({
    factory,
    maxSize,
    dbName: `polaris_test_${counter}`,
  });
}

describe("IndexedDbQueue", () => {
  it("requires a positive integer maxSize", () => {
    expect(() => new IndexedDbQueue({ factory, maxSize: 0 })).toThrowError(/maxSize/);
  });

  it("enqueue + size + drain happy path", async () => {
    const q = makeQueue(10);
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    await q.enqueue(entry("03"));
    expect(await q.size()).toBe(3);
    const drained = await q.drain(2);
    expect(drained.length).toBe(2);
    // Drained events should be the oldest two by UUIDv7 primary key order.
    const ids = drained.map((e) => e.payload.event_id.slice(-2));
    expect(ids).toContain("01");
    expect(ids).toContain("02");
    expect(await q.size()).toBe(1);
  });

  it("drainAll returns every entry and empties the store", async () => {
    const q = makeQueue(10);
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    const all = await q.drainAll();
    expect(all.length).toBe(2);
    expect(await q.size()).toBe(0);
  });

  it("evicts oldest-low under overflow", async () => {
    const q = makeQueue(3);
    await q.enqueue(entry("01", "low"));
    await q.enqueue(entry("02", "high"));
    await q.enqueue(entry("03", "normal"));
    const result = await q.enqueue(entry("04", "normal"));
    expect(result.status).toBe("accepted_with_drops");
    if (result.status === "accepted_with_drops") {
      const droppedId = result.dropped[0]?.payload.event_id.slice(-2);
      expect(droppedId).toBe("01");
    }
    expect(await q.size()).toBe(3);
  });

  it("rejects when nothing can be evicted", async () => {
    const q = makeQueue(2);
    await q.enqueue(entry("01", "high"));
    await q.enqueue(entry("02", "high"));
    const result = await q.enqueue(entry("03", "low"));
    expect(result.status).toBe("rejected");
    expect(await q.size()).toBe(2);
  });

  it("persists entries across instances (simulated tab reload)", async () => {
    const q1 = new IndexedDbQueue({
      factory,
      maxSize: 10,
      dbName: "polaris_reload_test",
    });
    await q1.enqueue(entry("01"));
    await q1.enqueue(entry("02"));
    await q1.close();
    const q2 = new IndexedDbQueue({
      factory,
      maxSize: 10,
      dbName: "polaris_reload_test",
    });
    expect(await q2.size()).toBe(2);
    const drained = await q2.drainAll();
    expect(drained.length).toBe(2);
  });

  it("requeue preserves event_id at the head for retry", async () => {
    const q = makeQueue(10);
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    const drained = await q.drain(2);
    await q.requeue(drained);
    const drainedAgain = await q.drainAll();
    const ids1 = drained.map((e) => e.payload.event_id);
    const ids2 = drainedAgain.map((e) => e.payload.event_id);
    expect(new Set(ids2)).toEqual(new Set(ids1));
  });

  it("requeue trims oldest excess when count > maxSize", async () => {
    const q = makeQueue(2);
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    const drained = await q.drain(2);
    await q.enqueue(entry("03"));
    await q.enqueue(entry("04"));
    // Now requeue the older two — total would be 4, max is 2.
    await q.requeue(drained);
    expect(await q.size()).toBeLessThanOrEqual(2);
  });
});

describe("probeIndexedDb", () => {
  it("returns true when the factory works", async () => {
    expect(await probeIndexedDb(factory)).toBe(true);
  });

  it("returns false when no factory is supplied", async () => {
    expect(await probeIndexedDb(undefined)).toBe(false);
  });
});
