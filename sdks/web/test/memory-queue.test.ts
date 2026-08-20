/**
 * `MemoryQueue` — last-resort queue layer.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * Memory queue tests assert:
 *
 *   - FIFO drain semantics within priority
 *   - bounded capacity with priority-based overflow eviction
 *   - track() never throws on overflow; the helper surfaces drops via the
 *     EnqueueOutcome shape
 *   - requeue preserves event_id at the head for retry
 *   - drainAll returns everything for urgent flush
 */

import { describe, expect, it } from "vitest";

import { MemoryQueue } from "../src/queue/memory-queue.js";
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

describe("MemoryQueue", () => {
  it("requires a positive integer maxSize", () => {
    expect(() => new MemoryQueue({ maxSize: 0 })).toThrowError(/maxSize/);
    expect(() => new MemoryQueue({ maxSize: -1 })).toThrowError(/maxSize/);
  });

  it("enqueue followed by size and drain returns FIFO", async () => {
    const q = new MemoryQueue({ maxSize: 10 });
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    await q.enqueue(entry("03"));
    expect(await q.size()).toBe(3);
    const drained = await q.drain(2);
    expect(drained.map((e) => e.payload.event_id.slice(-2))).toEqual(["01", "02"]);
    expect(await q.size()).toBe(1);
  });

  it("rejects new entries when the queue is full of higher priority", async () => {
    const q = new MemoryQueue({ maxSize: 2 });
    await q.enqueue(entry("01", "high"));
    await q.enqueue(entry("02", "high"));
    const result = await q.enqueue(entry("03", "low"));
    expect(result.status).toBe("rejected");
    expect(await q.size()).toBe(2);
  });

  it("evicts the oldest low-priority entry under overflow", async () => {
    const q = new MemoryQueue({ maxSize: 3 });
    await q.enqueue(entry("01", "low"));
    await q.enqueue(entry("02", "normal"));
    await q.enqueue(entry("03", "high"));
    const result = await q.enqueue(entry("04", "normal"));
    expect(result.status).toBe("accepted_with_drops");
    if (result.status === "accepted_with_drops") {
      expect(result.dropped[0]?.payload.event_id.slice(-2)).toBe("01");
    }
    const drained = await q.drainAll();
    // The remaining queue should be [02, 03, 04] in FIFO order.
    expect(drained.map((e) => e.payload.event_id.slice(-2))).toEqual(["02", "03", "04"]);
  });

  it("drainAll empties the queue", async () => {
    const q = new MemoryQueue({ maxSize: 10 });
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    expect((await q.drainAll()).length).toBe(2);
    expect(await q.size()).toBe(0);
  });

  it("requeue puts events back at the head for retry", async () => {
    const q = new MemoryQueue({ maxSize: 10 });
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    const drained = await q.drain(2);
    // Simulate transient transport failure: requeue both.
    await q.requeue(drained);
    const drainedAgain = await q.drain(2);
    // Same event_ids in the same order — preserves event_id across retries.
    expect(drainedAgain.map((e) => e.payload.event_id)).toEqual(
      drained.map((e) => e.payload.event_id),
    );
  });

  it("requeue does not exceed maxSize", async () => {
    const q = new MemoryQueue({ maxSize: 2 });
    await q.enqueue(entry("01"));
    await q.enqueue(entry("02"));
    const drained = await q.drain(2);
    // Fill the queue back up with newer entries.
    await q.enqueue(entry("03"));
    await q.enqueue(entry("04"));
    // Requeue the older drained events. The queue stays bounded.
    await q.requeue(drained);
    expect(await q.size()).toBe(2);
  });
});
