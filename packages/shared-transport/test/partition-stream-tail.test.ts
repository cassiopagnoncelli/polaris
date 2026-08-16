/**
 * `followStream` — the checkpoint-free live reader behind
 * `polaris events tail` (V3L2TLWC). Its bounded sibling
 * `readStreamRange` is covered in `partition-stream-range.test.ts`.
 *
 * The load-bearing property is negative: this module must never be able
 * to move a real consumer's position. That is asserted structurally (it
 * takes no checkpoint store and joins no group — there is no seam through
 * which it could) and behaviourally, by driving it through the same
 * in-memory driver seam the range reader's tests use.
 */

import { describe, expect, it } from "vitest";

import {
  followStream,
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_EVENT_NAME,
  POLARIS_HEADER_INGESTED_AT,
  POLARIS_HEADER_OCCURRED_AT,
  POLARIS_HEADER_PROJECT_ID,
  type StreamRangeDelivery,
  type StreamRangeDriver,
  type StreamRangeEvent,
} from "../src/index.js";

const BASE_MS = Date.parse("2026-08-16T10:00:00.000Z");

function delivery(overrides: Partial<StreamRangeDelivery> = {}): StreamRangeDelivery {
  return {
    offset: "1",
    timestampMs: BASE_MS,
    headers: {
      [POLARIS_HEADER_EVENT_ID]: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      [POLARIS_HEADER_EVENT_NAME]: "page.viewed",
      [POLARIS_HEADER_PROJECT_ID]: "storefront",
      [POLARIS_HEADER_ENVIRONMENT]: "production",
      [POLARIS_HEADER_OCCURRED_AT]: "2026-08-16T10:00:00.000Z",
      [POLARIS_HEADER_INGESTED_AT]: "2026-08-16T10:00:00.000Z",
    },
    key: "profile-1",
    value: new TextEncoder().encode('{"event":"page.viewed"}'),
    ...overrides,
  };
}

/**
 * Driver double. Hands the reader a scripted burst on `start`, then holds
 * the attach open exactly as the real one does.
 */
function scriptedDriver(deliveries: readonly StreamRangeDelivery[]) {
  let released = 0;
  let closedHook: (() => void) | undefined;
  const attachedWith: unknown[] = [];
  const driver: StreamRangeDriver = {
    async start({ offsetSpec, onMessage, onClosed }) {
      attachedWith.push(offsetSpec);
      closedHook = onClosed;
      for (const d of deliveries) onMessage(d);
    },
    async release() {
      released += 1;
    },
  };
  return {
    driver,
    attachedWith,
    releasedCount: () => released,
    closeChannel: () => closedHook?.(),
  };
}

function collect() {
  const events: StreamRangeEvent[] = [];
  return { events, onEvent: (e: StreamRangeEvent) => events.push(e) };
}

describe("followStream — attach point", () => {
  it("hands the driver a whole-second timestamp offset", async () => {
    // RabbitMQ reads an AMQP timestamp offset as SECONDS; attaching with
    // milliseconds would land roughly 55 years in the future and the tail
    // would show nothing, forever, with no error to explain it.
    //
    // Asserted through the driver rather than against the conversion
    // helper: this is the value that actually reaches the broker.
    const controller = new AbortController();
    const { driver, attachedWith } = scriptedDriver([]);
    const running = followStream(driver, {
      stream: "resolved.events-0",
      fromTimestampMs: 1_755_338_400_500,
      onEvent: () => {},
      signal: controller.signal,
    });
    controller.abort();
    await running;

    expect(attachedWith[0]).toEqual({ "!": "timestamp", value: 1_755_338_400 });
  });
});

describe("followStream — delivery", () => {
  it("projects each message and stops when aborted", async () => {
    const controller = new AbortController();
    const { driver } = scriptedDriver([delivery({ offset: "7" })]);
    const { events, onEvent } = collect();

    const running = followStream(driver, {
      stream: "resolved.events-2",
      fromTimestampMs: BASE_MS,
      onEvent,
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;

    expect(result.terminationReason).toBe("aborted");
    expect(result.delivered).toBe(1);
    expect(result.lastOffset).toBe("7");
    expect(events[0]?.event_id).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
    expect(events[0]?.stream).toBe("resolved.events-2");
    expect(events[0]?.partition).toBe(2);
  });

  it("releases the driver on every exit path", async () => {
    const controller = new AbortController();
    const { driver, releasedCount } = scriptedDriver([delivery()]);
    const running = followStream(driver, {
      stream: "resolved.events-0",
      fromTimestampMs: BASE_MS,
      onEvent: () => {},
      signal: controller.signal,
    });
    controller.abort();
    await running;
    expect(releasedCount()).toBe(1);
  });

  it("stops at maxEvents without needing an abort", async () => {
    const { driver } = scriptedDriver([
      delivery({ offset: "1" }),
      delivery({ offset: "2" }),
      delivery({ offset: "3" }),
    ]);
    const { events, onEvent } = collect();
    const result = await followStream(driver, {
      stream: "resolved.events-0",
      fromTimestampMs: BASE_MS,
      onEvent,
      maxEvents: 2,
    });
    expect(result.terminationReason).toBe("max_events");
    expect(events).toHaveLength(2);
  });

  it("ends with channel_closed when the driver reports a dead channel", async () => {
    const { driver, closeChannel } = scriptedDriver([]);
    const running = followStream(driver, {
      stream: "resolved.events-0",
      fromTimestampMs: BASE_MS,
      onEvent: () => {},
    });
    closeChannel();
    const result = await running;
    expect(result.terminationReason).toBe("channel_closed");
  });

  it("returns immediately for an already-aborted signal without attaching", async () => {
    let started = 0;
    const driver: StreamRangeDriver = {
      async start() {
        started += 1;
      },
      async release() {},
    };
    const result = await followStream(driver, {
      stream: "resolved.events-0",
      fromTimestampMs: BASE_MS,
      onEvent: () => {},
      signal: AbortSignal.abort(),
    });
    expect(result.terminationReason).toBe("aborted");
    expect(started).toBe(0);
  });
});

describe("followStream — chunk-granular attach", () => {
  it("drops messages older than the requested start", async () => {
    // RabbitMQ positions at the start of the chunk containing the
    // timestamp, so an operator asking for "from now" would otherwise
    // watch the chunk's backlog scroll past first and conclude the tail
    // was showing stale traffic.
    const { driver } = scriptedDriver([
      delivery({
        offset: "1",
        headers: {
          ...delivery().headers,
          [POLARIS_HEADER_INGESTED_AT]: "2026-08-16T09:59:00.000Z",
        },
      }),
      delivery({ offset: "2" }),
    ]);
    const { events, onEvent } = collect();
    await followStream(driver, {
      stream: "resolved.events-0",
      fromTimestampMs: BASE_MS,
      onEvent,
      maxEvents: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.offset).toBe("2");
  });

  it("falls back to the broker timestamp when the ingested-at header is absent", async () => {
    const headers = { ...delivery().headers };
    delete headers[POLARIS_HEADER_INGESTED_AT];
    const { driver } = scriptedDriver([
      delivery({ offset: "1", headers, timestampMs: BASE_MS - 60_000 }),
      delivery({ offset: "2", headers, timestampMs: BASE_MS + 1_000 }),
    ]);
    const { events, onEvent } = collect();
    await followStream(driver, {
      stream: "resolved.events-0",
      fromTimestampMs: BASE_MS,
      onEvent,
      maxEvents: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.offset).toBe("2");
  });
});

describe("followStream — foreign messages", () => {
  it("reports an unprojectable message instead of swallowing it", async () => {
    // A publish without the platform headers is a real thing on a shared
    // broker. Dropping it silently makes a working tail look broken.
    const seen: StreamRangeDelivery[] = [];
    const { driver } = scriptedDriver([delivery({ headers: {} })]);
    const controller = new AbortController();
    const running = followStream(driver, {
      stream: "resolved.events-0",
      fromTimestampMs: BASE_MS,
      onEvent: () => {
        throw new Error("must not project a header-less message");
      },
      onUnprojectable: (d) => seen.push(d),
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await running;

    expect(outcome.delivered).toBe(0);
    expect(seen).toHaveLength(1);
  });
});
