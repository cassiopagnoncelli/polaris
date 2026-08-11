import { describe, expect, it } from "vitest";

import {
  rangeOffsetSpec,
  readStreamRange,
  type StreamRangeDelivery,
  type StreamRangeDriver,
} from "../src/stream-range-reader.js";

const WINDOW_FROM = Date.parse("2026-08-01T00:00:00.000Z");
const WINDOW_TO = Date.parse("2026-08-01T01:00:00.000Z");

function delivery(input: {
  offset: number;
  ingestedAt: string;
  eventId?: string;
  occurredAt?: string;
  headers?: Record<string, string>;
}): StreamRangeDelivery {
  return {
    offset: String(input.offset),
    timestampMs: Date.parse(input.ingestedAt),
    key: "project-alpha:production:cust-1",
    value: new Uint8Array([1, 2, 3]),
    headers: {
      "polaris-event-id": input.eventId ?? `e${String(input.offset)}`,
      "polaris-event-name": "page_viewed",
      "polaris-project-id": "project-alpha",
      "polaris-environment": "production",
      "polaris-occurred-at": input.occurredAt ?? input.ingestedAt,
      "polaris-ingested-at": input.ingestedAt,
      ...(input.headers ?? {}),
    },
  };
}

/** Driver that replays a fixed script into the reader. */
function scriptedDriver(deliveries: ReadonlyArray<StreamRangeDelivery>): {
  driver: StreamRangeDriver;
  released: () => boolean;
} {
  let released = false;
  const driver: StreamRangeDriver = {
    async start({ onMessage }) {
      for (const item of deliveries) onMessage(item);
    },
    async release() {
      released = true;
    },
  };
  return { driver, released: () => released };
}

describe("rangeOffsetSpec", () => {
  it("attaches at the window's start timestamp, in seconds", () => {
    // RabbitMQ interprets an AMQP timestamp offset as POSIX seconds.
    expect(
      rangeOffsetSpec({ stream: "raw.events-0", fromTimestampMs: 1_760_000_500, toTimestampMs: 0 }),
    ).toEqual({
      "!": "timestamp",
      value: 1_760_000,
    });
  });

  it("prefers an explicit resume offset", () => {
    expect(
      rangeOffsetSpec({
        stream: "raw.events-0",
        fromTimestampMs: WINDOW_FROM,
        toTimestampMs: WINDOW_TO,
        startOffset: "500",
      }),
    ).toEqual({ "!": "long", value: "500" });
  });
});

describe("readStreamRange", () => {
  it("returns every event inside the window and stops past it", async () => {
    const { driver, released } = scriptedDriver([
      delivery({ offset: 1, ingestedAt: "2026-08-01T00:10:00.000Z" }),
      delivery({ offset: 2, ingestedAt: "2026-08-01T00:20:00.000Z" }),
      // Past window_to + the default 15m slack.
      delivery({ offset: 3, ingestedAt: "2026-08-01T02:00:00.000Z" }),
      delivery({ offset: 4, ingestedAt: "2026-08-01T02:10:00.000Z" }),
    ]);

    const result = await readStreamRange(driver, {
      stream: "raw.events-2",
      fromTimestampMs: WINDOW_FROM,
      toTimestampMs: WINDOW_TO,
    });

    expect(result.events.map((e) => e.offset)).toEqual(["1", "2"]);
    expect(result.terminationReason).toBe("window_complete");
    expect(result.lastOffset).toBe("2");
    expect(released()).toBe(true);
  });

  it("reads past window_to by the slack so late-arriving events are not missed", async () => {
    // occurred_at inside the window, ingested 10 minutes after it closed.
    const { driver } = scriptedDriver([
      delivery({
        offset: 1,
        ingestedAt: "2026-08-01T01:10:00.000Z",
        occurredAt: "2026-08-01T00:55:00.000Z",
      }),
      delivery({ offset: 2, ingestedAt: "2026-08-01T03:00:00.000Z" }),
    ]);

    const result = await readStreamRange(driver, {
      stream: "raw.events-0",
      fromTimestampMs: WINDOW_FROM,
      toTimestampMs: WINDOW_TO,
    });

    expect(result.events.map((e) => e.offset)).toEqual(["1"]);
  });

  it("projects platform headers onto the typed replay shape", async () => {
    const { driver } = scriptedDriver([
      delivery({ offset: 9, ingestedAt: "2026-08-01T00:30:00.000Z", eventId: "evt-9" }),
    ]);

    const result = await readStreamRange(driver, {
      stream: "raw.events-1",
      fromTimestampMs: WINDOW_FROM,
      toTimestampMs: WINDOW_TO,
      idleTimeoutMs: 20,
    });

    expect(result.events[0]).toMatchObject({
      stream: "raw.events-1",
      partition: 1,
      offset: "9",
      event_id: "evt-9",
      event_name: "page_viewed",
      project_id: "project-alpha",
      environment: "production",
      partition_key: "project-alpha:production:cust-1",
    });
    expect(result.events[0]?.headers["polaris-ingested-at"]).toBe("2026-08-01T00:30:00.000Z");
  });

  it("stops on idle when the tail is reached inside the window", async () => {
    const { driver } = scriptedDriver([
      delivery({ offset: 1, ingestedAt: "2026-08-01T00:10:00.000Z" }),
    ]);

    const result = await readStreamRange(driver, {
      stream: "raw.events-0",
      fromTimestampMs: WINDOW_FROM,
      toTimestampMs: WINDOW_TO,
      idleTimeoutMs: 20,
    });

    // A replay window may run to "now"; the reader must not block waiting
    // for traffic that has not happened yet.
    expect(result.terminationReason).toBe("idle_timeout");
    expect(result.events).toHaveLength(1);
  });

  it("stops at maxEvents and reports where to resume", async () => {
    const { driver } = scriptedDriver([
      delivery({ offset: 1, ingestedAt: "2026-08-01T00:10:00.000Z" }),
      delivery({ offset: 2, ingestedAt: "2026-08-01T00:11:00.000Z" }),
      delivery({ offset: 3, ingestedAt: "2026-08-01T00:12:00.000Z" }),
    ]);

    const result = await readStreamRange(driver, {
      stream: "raw.events-0",
      fromTimestampMs: WINDOW_FROM,
      toTimestampMs: WINDOW_TO,
      maxEvents: 2,
      idleTimeoutMs: 20,
    });

    expect(result.terminationReason).toBe("max_events");
    expect(result.lastOffset).toBe("2");
  });

  it("skips messages that carry no Polaris platform headers", async () => {
    const foreign: StreamRangeDelivery = {
      offset: "5",
      timestampMs: Date.parse("2026-08-01T00:15:00.000Z"),
      key: null,
      value: new Uint8Array(),
      headers: {},
    };
    const { driver } = scriptedDriver([
      foreign,
      delivery({ offset: 6, ingestedAt: "2026-08-01T00:16:00.000Z" }),
    ]);

    const result = await readStreamRange(driver, {
      stream: "raw.events-0",
      fromTimestampMs: WINDOW_FROM,
      toTimestampMs: WINDOW_TO,
      idleTimeoutMs: 20,
    });

    // A foreign publish must not fail the whole replay.
    expect(result.events.map((e) => e.offset)).toEqual(["6"]);
  });

  it("reports a mid-read channel close", async () => {
    const driver: StreamRangeDriver = {
      async start({ onMessage, onClosed }) {
        onMessage(delivery({ offset: 1, ingestedAt: "2026-08-01T00:10:00.000Z" }));
        onClosed();
      },
      async release() {},
    };

    const result = await readStreamRange(driver, {
      stream: "raw.events-0",
      fromTimestampMs: WINDOW_FROM,
      toTimestampMs: WINDOW_TO,
    });

    expect(result.terminationReason).toBe("channel_closed");
    expect(result.lastOffset).toBe("1");
  });
});
