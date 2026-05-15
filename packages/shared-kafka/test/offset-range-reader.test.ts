/**
 * Unit tests for the offset-range reader (`@polaris/shared-kafka`
 * adapter for the replay control plane). The reader is the only seam in
 * the replay path that actually talks to Redpanda; everything else is
 * pure orchestration. The tests below assert the behavioral contract the
 * `@polaris/shared-replay` executor relies on:
 *
 *   - empty range -> no events, no driver I/O beyond release.
 *   - single-message range -> the message is projected onto the Polaris
 *     header conventions and surfaces with the executor's expected
 *     field set.
 *   - multi-partition range -> the same reader can be invoked twice
 *     (once per partition) and produces independent event streams.
 *   - partition reassignment mid-read -> the driver delivers a batch
 *     from a different partition, the reader stops and returns what it
 *     collected with `terminationReason: 'rebalance'`.
 *
 * Each test wires a synthetic {@link OffsetRangeConsumerDriver} so no
 * Redpanda / KafkaJS is required.
 *
 * @see packages/shared-kafka/src/offset-range-reader.ts
 * @see agents/pm/kanban/doing/Q0EGTY5V-replay-cli-offset-range-reader-in-polaris-shared-kafka.md
 */

import { describe, expect, it } from "vitest";

import {
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_EVENT_NAME,
  POLARIS_HEADER_OCCURRED_AT,
  POLARIS_HEADER_PROJECT_ID,
} from "../src/headers.js";
import {
  type OffsetRangeBatch,
  type OffsetRangeBatchMessage,
  type OffsetRangeConsumerDriver,
  readOffsetRange,
} from "../src/offset-range-reader.js";

// ---------------------------------------------------------------------------
// Driver helpers
// ---------------------------------------------------------------------------

interface DriverCalls {
  assigns: Array<{ topic: string; partition: number }>;
  seeks: Array<{ topic: string; partition: number; offset: string }>;
  pulls: number;
  releases: number;
}

/**
 * Build a synthetic consumer driver that hands out a pre-scripted
 * sequence of batches. After the script is exhausted, the driver returns
 * `null` on every subsequent pull (signalling end-of-stream).
 */
function makeDriver(batches: ReadonlyArray<OffsetRangeBatch | null>): {
  driver: OffsetRangeConsumerDriver;
  calls: DriverCalls;
} {
  const calls: DriverCalls = { assigns: [], seeks: [], pulls: 0, releases: 0 };
  let cursor = 0;
  const driver: OffsetRangeConsumerDriver = {
    async assign(topic, partition) {
      calls.assigns.push({ topic, partition });
    },
    async seek(topic, partition, offset) {
      calls.seeks.push({ topic, partition, offset });
    },
    async pullNextBatch() {
      calls.pulls += 1;
      if (cursor >= batches.length) return null;
      const next = batches[cursor];
      cursor += 1;
      return next ?? null;
    },
    async release() {
      calls.releases += 1;
    },
  };
  return { driver, calls };
}

/** Build a Polaris-shaped message with all required headers set. */
function makeMessage(opts: {
  readonly offset: number | string;
  readonly eventId: string;
  readonly eventName?: string;
  readonly projectId?: string;
  readonly environment?: string;
  readonly occurredAt?: string;
  readonly key?: string | null;
  readonly value?: string;
  readonly extraHeaders?: Record<string, string>;
}): OffsetRangeBatchMessage {
  const headers: Record<string, Buffer | string> = {
    [POLARIS_HEADER_EVENT_ID]: opts.eventId,
    [POLARIS_HEADER_EVENT_NAME]: opts.eventName ?? "purchase",
    [POLARIS_HEADER_PROJECT_ID]: opts.projectId ?? "storefront",
    [POLARIS_HEADER_ENVIRONMENT]: opts.environment ?? "development",
    [POLARIS_HEADER_OCCURRED_AT]: opts.occurredAt ?? "2026-05-10T03:00:00.000Z",
    ...(opts.extraHeaders ?? {}),
  };
  return {
    offset: typeof opts.offset === "number" ? String(opts.offset) : opts.offset,
    key: opts.key ?? "storefront.development.user.42",
    value: Buffer.from(opts.value ?? `payload-${opts.eventId}`, "utf8"),
    headers,
  };
}

/** Build a batch containing the supplied messages with a chosen HWM. */
function makeBatch(
  topic: string,
  partition: number,
  highWatermark: number | string,
  messages: ReadonlyArray<OffsetRangeBatchMessage>,
): OffsetRangeBatch {
  return {
    topic,
    partition,
    highWatermark: typeof highWatermark === "number" ? String(highWatermark) : highWatermark,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readOffsetRange — empty range", () => {
  it("returns immediately when startOffset > endOffset without touching the driver", async () => {
    const { driver, calls } = makeDriver([]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 10,
      endOffset: 5,
    });
    expect(result.events).toHaveLength(0);
    expect(result.lastOffset).toBeNull();
    expect(result.terminationReason).toBe("empty_range");
    // The reader must short-circuit before any driver call.
    expect(calls.assigns).toHaveLength(0);
    expect(calls.seeks).toHaveLength(0);
    expect(calls.pulls).toBe(0);
    expect(calls.releases).toBe(0);
  });

  it("treats an in-range request against an empty partition as partition_end", async () => {
    // Driver yields zero batches, partition is empty.
    const { driver, calls } = makeDriver([null]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 0,
      endOffset: 100,
    });
    expect(result.events).toHaveLength(0);
    expect(result.lastOffset).toBeNull();
    expect(result.terminationReason).toBe("partition_end");
    expect(calls.assigns).toEqual([{ topic: "raw.events", partition: 0 }]);
    expect(calls.seeks).toEqual([{ topic: "raw.events", partition: 0, offset: "0" }]);
    expect(calls.releases).toBe(1);
  });
});

describe("readOffsetRange — single-message range", () => {
  it("returns the single in-range event projected through Polaris headers", async () => {
    const batch = makeBatch("raw.events", 0, 11, [
      makeMessage({
        offset: 10,
        eventId: "ev_one",
        extraHeaders: { "polaris-source-id": "ingester-api" },
      }),
    ]);
    const { driver } = makeDriver([batch, null]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 10,
      endOffset: 10,
    });
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.topic).toBe("raw.events");
    expect(event.partition).toBe(0);
    expect(event.offset).toBe("10");
    expect(event.event_id).toBe("ev_one");
    expect(event.event_name).toBe("purchase");
    expect(event.project_id).toBe("storefront");
    expect(event.environment).toBe("development");
    expect(event.occurred_at).toBe("2026-05-10T03:00:00.000Z");
    expect(event.partition_key).toBe("storefront.development.user.42");
    expect(Buffer.from(event.value).toString("utf8")).toBe("payload-ev_one");
    // Original non-platform headers survive through stringification.
    expect(event.headers["polaris-source-id"]).toBe("ingester-api");
    expect(result.lastOffset).toBe("10");
    expect(result.terminationReason).toBe("range_exhausted");
  });

  it("drops messages that pre-date startOffset within the same batch", async () => {
    // The driver may deliver a batch whose first message is below
    // startOffset (e.g. caller seeked to mid-batch). The reader must
    // skip them rather than count them as out-of-range.
    const batch = makeBatch("raw.events", 0, 5, [
      makeMessage({ offset: 1, eventId: "ev_skip" }),
      makeMessage({ offset: 2, eventId: "ev_target" }),
    ]);
    const { driver } = makeDriver([batch, null]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 2,
      endOffset: 2,
    });
    expect(result.events.map((event) => event.event_id)).toEqual(["ev_target"]);
    expect(result.lastOffset).toBe("2");
    expect(result.terminationReason).toBe("range_exhausted");
  });

  it("skips tombstones (value=null) and messages missing the polaris-event-id header", async () => {
    const batch: OffsetRangeBatch = {
      topic: "raw.events",
      partition: 0,
      highWatermark: "5",
      messages: [
        { offset: "0", key: null, value: null },
        // Missing polaris-event-id: the reader can't identify it, so it's
        // dropped from the result rather than thrown.
        {
          offset: "1",
          key: "k",
          value: Buffer.from("v", "utf8"),
          headers: { other: "h" },
        },
        makeMessage({ offset: 2, eventId: "ev_kept" }),
      ],
    };
    const { driver } = makeDriver([batch, null]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 0,
      endOffset: 2,
    });
    expect(result.events.map((event) => event.event_id)).toEqual(["ev_kept"]);
    expect(result.lastOffset).toBe("2");
    expect(result.terminationReason).toBe("range_exhausted");
  });
});

describe("readOffsetRange — multi-partition range", () => {
  it("reads each partition independently when called once per partition", async () => {
    // The reader's signature is single-partition. Multi-partition replay
    // calls it once per partition. This test asserts the two reads stay
    // isolated — distinct driver instances, distinct results.
    const batch0 = makeBatch("raw.events", 0, 3, [
      makeMessage({ offset: 0, eventId: "p0_a" }),
      makeMessage({ offset: 1, eventId: "p0_b" }),
      makeMessage({ offset: 2, eventId: "p0_c" }),
    ]);
    const batch1 = makeBatch("raw.events", 1, 2, [
      makeMessage({ offset: 0, eventId: "p1_a" }),
      makeMessage({ offset: 1, eventId: "p1_b" }),
    ]);
    const driver0 = makeDriver([batch0, null]);
    const driver1 = makeDriver([batch1, null]);

    const [r0, r1] = await Promise.all([
      readOffsetRange(driver0.driver, {
        topic: "raw.events",
        partition: 0,
        startOffset: 0,
        endOffset: 10,
      }),
      readOffsetRange(driver1.driver, {
        topic: "raw.events",
        partition: 1,
        startOffset: 0,
        endOffset: 10,
      }),
    ]);

    expect(r0.events.map((event) => event.event_id)).toEqual(["p0_a", "p0_b", "p0_c"]);
    expect(r0.events.every((event) => event.partition === 0)).toBe(true);
    expect(r0.terminationReason).toBe("partition_end");
    expect(r1.events.map((event) => event.event_id)).toEqual(["p1_a", "p1_b"]);
    expect(r1.events.every((event) => event.partition === 1)).toBe(true);
    expect(r1.terminationReason).toBe("partition_end");

    // Each driver was assigned only its own partition.
    expect(driver0.calls.assigns).toEqual([{ topic: "raw.events", partition: 0 }]);
    expect(driver1.calls.assigns).toEqual([{ topic: "raw.events", partition: 1 }]);
    expect(driver0.calls.releases).toBe(1);
    expect(driver1.calls.releases).toBe(1);
  });

  it("stops at endOffset when the partition still has higher offsets", async () => {
    // Bound the read short of the partition end — termination is
    // `range_exhausted`, not `partition_end`.
    const batch = makeBatch("raw.events", 0, 100, [
      makeMessage({ offset: 5, eventId: "ev_a" }),
      makeMessage({ offset: 6, eventId: "ev_b" }),
      makeMessage({ offset: 7, eventId: "ev_c" }),
    ]);
    const { driver } = makeDriver([batch, null]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 5,
      endOffset: 6,
    });
    expect(result.events.map((event) => event.event_id)).toEqual(["ev_a", "ev_b"]);
    expect(result.lastOffset).toBe("6");
    expect(result.terminationReason).toBe("range_exhausted");
  });
});

describe("readOffsetRange — partition reassignment mid-read", () => {
  it("aborts cleanly when the driver delivers a batch from a different partition", async () => {
    // First batch is in-scope; second batch comes from partition=1 (a
    // rebalance handed it to a different assignment). The reader must
    // return the events it already collected and report `rebalance`.
    const goodBatch = makeBatch("raw.events", 0, 10, [
      makeMessage({ offset: 0, eventId: "before_rebalance_a" }),
      makeMessage({ offset: 1, eventId: "before_rebalance_b" }),
    ]);
    const reassignedBatch = makeBatch("raw.events", 1, 10, [
      makeMessage({ offset: 0, eventId: "from_other_partition" }),
    ]);
    const { driver, calls } = makeDriver([goodBatch, reassignedBatch]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 0,
      endOffset: 99,
    });
    expect(result.events.map((event) => event.event_id)).toEqual([
      "before_rebalance_a",
      "before_rebalance_b",
    ]);
    expect(result.lastOffset).toBe("1");
    expect(result.terminationReason).toBe("rebalance");
    // Driver still released cleanly.
    expect(calls.releases).toBe(1);
  });

  it("aborts cleanly when the driver delivers a batch from a different topic", async () => {
    // The same defensive check fires if a misconfigured driver delivers
    // a batch from another topic (subscribe leak).
    const goodBatch = makeBatch("raw.events", 0, 10, [
      makeMessage({ offset: 0, eventId: "good" }),
    ]);
    const otherTopic = makeBatch("analytics.events", 0, 10, [
      makeMessage({ offset: 0, eventId: "leak" }),
    ]);
    const { driver } = makeDriver([goodBatch, otherTopic]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 0,
      endOffset: 99,
    });
    expect(result.events.map((event) => event.event_id)).toEqual(["good"]);
    expect(result.terminationReason).toBe("rebalance");
  });
});

describe("readOffsetRange — termination reasons", () => {
  it("terminates with idle_timeout when no batch is delivered within the deadline", async () => {
    // Driver hangs the pull until the abort signal fires.
    const driver: OffsetRangeConsumerDriver = {
      assign: async () => {},
      seek: async () => {},
      pullNextBatch: (signal) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve(null);
            return;
          }
          signal.addEventListener("abort", () => resolve(null), { once: true });
        }),
      release: async () => {},
    };
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 0,
      endOffset: 5,
      idleTimeoutMs: 5,
    });
    expect(result.events).toHaveLength(0);
    expect(result.terminationReason).toBe("idle_timeout");
  });

  it("returns range_exhausted when the read covers exactly the requested window", async () => {
    const batch = makeBatch("raw.events", 0, 50, [
      makeMessage({ offset: 10, eventId: "a" }),
      makeMessage({ offset: 11, eventId: "b" }),
      makeMessage({ offset: 12, eventId: "c" }),
    ]);
    const { driver } = makeDriver([batch, null]);
    const result = await readOffsetRange(driver, {
      topic: "raw.events",
      partition: 0,
      startOffset: 10,
      endOffset: 12,
    });
    expect(result.events.map((event) => event.event_id)).toEqual(["a", "b", "c"]);
    expect(result.terminationReason).toBe("range_exhausted");
  });
});
