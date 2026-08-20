/**
 * Priority overflow strategy.
 *
 * The doctrinal rule per `docs/architecture/10-sdk-standards.md`:
 *
 *   When the queue is full, drop in this order:
 *     oldest low
 *     oldest normal
 *     oldest high
 *
 *   If all queued events are `high`, drop the oldest high-priority event
 *   only as a last resort.
 *
 * The helper enforces both halves: drop oldest of the lowest priority
 * present (admits the incoming entry by evicting one), and refuse to
 * displace a strictly higher-priority entry with a lower-priority incoming
 * entry (returns -1 -> rejected).
 */

import { describe, expect, it } from "vitest";

import { pickEvictionIndex, rankOf } from "../src/queue/priority.js";
import type { EventPriority, QueueEntry } from "../src/types.js";

function entry(priority: EventPriority, idSuffix: string, enqueuedAt: number): QueueEntry {
  return {
    payload: {
      event_id: `00000000-0000-7000-8000-${idSuffix.padStart(12, "0")}`,
      event: "test.event",
      schema_version: 1,
      occurred_at: new Date(enqueuedAt).toISOString(),
      source: { type: "browser", id: "test", sdk: "web", sdk_version: "0.0.0" },
      identity: { anonymous_id: "a", session_id: "s", customer_id: null, device_id: null },
      context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
      properties: {},
    },
    priority,
    attempts: 0,
    enqueued_at: enqueuedAt,
  };
}

describe("priority rank", () => {
  it("ranks low < normal < high", () => {
    expect(rankOf("low")).toBeLessThan(rankOf("normal"));
    expect(rankOf("normal")).toBeLessThan(rankOf("high"));
  });
});

describe("pickEvictionIndex", () => {
  it("returns -1 when the queue is empty", () => {
    expect(pickEvictionIndex([], entry("normal", "01", 1))).toBe(-1);
  });

  it("drops the oldest low first", () => {
    const queue = [
      entry("high", "01", 1),
      entry("low", "02", 2),
      entry("normal", "03", 3),
      entry("low", "04", 4),
    ];
    // Both index 1 and 3 are low; oldest (index 1) wins.
    expect(pickEvictionIndex(queue, entry("normal", "99", 99))).toBe(1);
  });

  it("falls back to oldest normal when no low is queued", () => {
    const queue = [
      entry("high", "01", 1),
      entry("normal", "02", 2),
      entry("normal", "03", 3),
      entry("high", "04", 4),
    ];
    expect(pickEvictionIndex(queue, entry("high", "99", 99))).toBe(1);
  });

  it("falls back to oldest high when every entry is high and incoming is high", () => {
    const queue = [entry("high", "01", 1), entry("high", "02", 2), entry("high", "03", 3)];
    expect(pickEvictionIndex(queue, entry("high", "99", 99))).toBe(0);
  });

  it("rejects (returns -1) a low incoming when the queue is full of higher priorities", () => {
    const queue = [entry("high", "01", 1), entry("normal", "02", 2), entry("high", "03", 3)];
    expect(pickEvictionIndex(queue, entry("low", "99", 99))).toBe(-1);
  });

  it("rejects (returns -1) a normal incoming when the queue is full of high", () => {
    const queue = [entry("high", "01", 1), entry("high", "02", 2), entry("high", "03", 3)];
    expect(pickEvictionIndex(queue, entry("normal", "99", 99))).toBe(-1);
  });

  it("treats equal-priority eviction as oldest-first (drop oldest of same priority)", () => {
    const queue = [entry("normal", "01", 1), entry("normal", "02", 2), entry("normal", "03", 3)];
    expect(pickEvictionIndex(queue, entry("normal", "99", 99))).toBe(0);
  });
});
