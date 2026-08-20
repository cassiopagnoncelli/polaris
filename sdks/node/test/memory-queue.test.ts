import { describe, expect, it } from "vitest";

import { MemoryQueueAdapter } from "../src/queue/memory.js";
import type { QueuedEvent } from "../src/types.js";

function makeEvent(id: string): QueuedEvent {
  return {
    event_id: id,
    event: "test.event",
    schema_version: 1,
    occurred_at: "2026-05-12T12:00:00.000Z",
    source: { type: "backend", id: "test", sdk: "node", sdk_version: "0.0.0" },
    identity: { anonymous_id: null, session_id: null, customer_id: null, device_id: null },
    context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
    properties: {},
  };
}

describe("MemoryQueueAdapter", () => {
  it("rejects non-positive maxSize", () => {
    expect(() => new MemoryQueueAdapter({ maxSize: 0 })).toThrowError();
    expect(() => new MemoryQueueAdapter({ maxSize: -1 })).toThrowError();
  });

  it("accepts events up to maxSize and rejects overflow", () => {
    const queue = new MemoryQueueAdapter({ maxSize: 2 });
    expect(queue.enqueue(makeEvent("a"))).toBe(true);
    expect(queue.enqueue(makeEvent("b"))).toBe(true);
    expect(queue.enqueue(makeEvent("c"))).toBe(false);
    expect(queue.size()).toBe(2);
  });

  it("drains FIFO", () => {
    const queue = new MemoryQueueAdapter({ maxSize: 5 });
    queue.enqueue(makeEvent("a"));
    queue.enqueue(makeEvent("b"));
    queue.enqueue(makeEvent("c"));
    const batch = queue.drain(2);
    expect(batch.map((e) => e.event_id)).toEqual(["a", "b"]);
    expect(queue.size()).toBe(1);
    const rest = queue.drain(10);
    expect(rest.map((e) => e.event_id)).toEqual(["c"]);
    expect(queue.size()).toBe(0);
  });

  it("requeues at the head preserving order", () => {
    const queue = new MemoryQueueAdapter({ maxSize: 5 });
    queue.enqueue(makeEvent("a"));
    queue.enqueue(makeEvent("b"));
    const batch = queue.drain(2);
    queue.enqueue(makeEvent("c"));
    queue.requeue(batch);
    const all = queue.drain(10);
    expect(all.map((e) => e.event_id)).toEqual(["a", "b", "c"]);
  });

  it("requeue caps to maxSize by trimming the tail", () => {
    const queue = new MemoryQueueAdapter({ maxSize: 3 });
    queue.enqueue(makeEvent("x"));
    queue.enqueue(makeEvent("y"));
    queue.enqueue(makeEvent("z"));
    queue.requeue([makeEvent("a"), makeEvent("b")]);
    const all = queue.drain(10);
    expect(all.map((e) => e.event_id)).toEqual(["a", "b", "x"]);
  });

  it("drain on empty queue returns empty array", () => {
    const queue = new MemoryQueueAdapter({ maxSize: 5 });
    expect(queue.drain(10)).toEqual([]);
  });
});
