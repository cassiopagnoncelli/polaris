import {
  ArchiveBatcher,
  createArchiveWriter,
  createInMemoryArchiveStore,
} from "@polaris/archive-writer";
import { ProcessorMetrics } from "@polaris/pipeline";
import type { TransportMessagePayload } from "@polaris/bus";
import { describe, expect, it, vi } from "vitest";

import { createArchiveHandler, startFlushLoop } from "../src/runtime.js";

const IDENTITY = { processor_name: "archiver", processor_version: "v1" };

function silentLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function delivery(body: string, offset = "1"): TransportMessagePayload {
  return {
    stream: "raw.events-0",
    family: "raw.events",
    partition: 0,
    message: {
      value: Buffer.from(body, "utf8"),
      key: null,
      headers: {},
      offset,
      timestamp: "1755000000000",
      redelivered: false,
    },
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "purchase",
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-08-15T10:00:00.000Z",
    ...overrides,
  });
}

describe("createArchiveHandler", () => {
  it("files an event under the day its occurred_at falls on", async () => {
    const batcher = new ArchiveBatcher({ maxBytes: 1, maxRecords: 1, maxAgeMs: 1 });
    const store = createInMemoryArchiveStore();
    const writer = createArchiveWriter({
      store,
      batcher,
      prefix: "polaris",
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const handle = createArchiveHandler({
      batcher,
      logger: silentLogger() as never,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
      now: () => 0,
    });

    await handle(delivery(envelope({ occurred_at: "2026-08-15T10:00:00.000Z" })));
    await writer.flush(0, true);

    // The archiver's clock says the 20th. The event says the 15th, and
    // the event wins — a replay of the 15th must find it.
    const keys = [...store.objects.keys()].filter((key) => !key.includes("_manifest"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("/2026-08-15/");
  });

  it("stores the payload verbatim, not a re-serialisation", async () => {
    // Replay republishes these bytes. Key order and formatting survive
    // only if nothing re-encodes them.
    const raw =
      '{"occurred_at":"2026-08-15T10:00:00.000Z","project_id":"storefront","environment":"production","event":"purchase","event_id":"a","zzz":1.50}';
    const batcher = new ArchiveBatcher({ maxBytes: 1, maxRecords: 1, maxAgeMs: 1 });
    const store = createInMemoryArchiveStore();
    const writer = createArchiveWriter({
      store,
      batcher,
      prefix: "polaris",
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });
    const handle = createArchiveHandler({
      batcher,
      logger: silentLogger() as never,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
      now: () => 0,
    });

    await handle(delivery(raw));
    await writer.flush(0, true);

    const [body] = [...store.objects.entries()]
      .filter(([key]) => !key.includes("_manifest"))
      .map(([, value]) => value);
    expect(body).toBe(`${raw}\n`);
  });

  it("skips an envelope with an unparseable occurred_at rather than filing it under today", async () => {
    // Filing it under the archiver's clock would hide it from a replay of
    // the day it actually happened — a loss that only surfaces years
    // later, during an un-merge.
    const batcher = new ArchiveBatcher({ maxBytes: 1, maxRecords: 1, maxAgeMs: 1 });
    const metrics = new ProcessorMetrics();
    const handle = createArchiveHandler({
      batcher,
      logger: silentLogger() as never,
      metrics,
      identity: IDENTITY,
      now: () => 0,
    });

    await handle(delivery(envelope({ occurred_at: "the fifteenth" })));

    expect(batcher.bufferedRecords()).toBe(0);
    expect(
      metrics
        .getSamples()
        .some((sample) => JSON.stringify(sample).includes("unparseable_occurred_at")),
    ).toBe(true);
  });

  it("skips an envelope with no project scope", async () => {
    const batcher = new ArchiveBatcher({ maxBytes: 1, maxRecords: 1, maxAgeMs: 1 });
    const handle = createArchiveHandler({
      batcher,
      logger: silentLogger() as never,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
      now: () => 0,
    });

    await handle(delivery(JSON.stringify({ event: "purchase" })));

    expect(batcher.bufferedRecords()).toBe(0);
  });

  it("counts an undecodable payload instead of throwing", async () => {
    // Throwing would park a message no retry can fix.
    const batcher = new ArchiveBatcher({ maxBytes: 1, maxRecords: 1, maxAgeMs: 1 });
    const handle = createArchiveHandler({
      batcher,
      logger: silentLogger() as never,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
      now: () => 0,
    });

    await expect(handle(delivery("{not json"))).resolves.toBeUndefined();
    expect(batcher.bufferedRecords()).toBe(0);
  });

  it("separates two projects on the same stream into their own objects", async () => {
    const batcher = new ArchiveBatcher({ maxBytes: 1_000_000, maxRecords: 100, maxAgeMs: 60_000 });
    const store = createInMemoryArchiveStore();
    const writer = createArchiveWriter({
      store,
      batcher,
      prefix: "polaris",
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });
    const handle = createArchiveHandler({
      batcher,
      logger: silentLogger() as never,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
      now: () => 0,
    });

    await handle(delivery(envelope({ project_id: "storefront" }), "1"));
    await handle(delivery(envelope({ project_id: "checkout" }), "2"));
    await writer.flush(0, true);

    const keys = [...store.objects.keys()].filter((key) => !key.includes("_manifest"));
    expect(keys.some((key) => key.includes("/storefront/"))).toBe(true);
    expect(keys.some((key) => key.includes("/checkout/"))).toBe(true);
  });
});

describe("startFlushLoop", () => {
  it("flushes on the timer, which is what makes the age bound real", async () => {
    // Without the loop, an aged-out batch only closes when the next
    // message on the same stream arrives — which on a quiet project is
    // exactly when it will not.
    vi.useFakeTimers();
    try {
      const flush = vi.fn(async () => ({}));
      const loop = startFlushLoop({
        flush,
        intervalMs: 1_000,
        now: () => 0,
        onError: () => {},
      });

      await vi.advanceTimersByTimeAsync(3_500);
      expect(flush).toHaveBeenCalledTimes(3);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces a final flush on stop, so a deploy does not re-read what it could have written", async () => {
    const calls: Array<boolean | undefined> = [];
    const loop = startFlushLoop({
      flush: async (_now, force) => {
        calls.push(force);
        return {};
      },
      intervalMs: 60_000,
      now: () => 0,
      onError: () => {},
    });

    await loop.stop();

    expect(calls).toEqual([true]);
  });

  it("survives a flush that throws", async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const loop = startFlushLoop({
        flush: async () => {
          throw new Error("s3 down");
        },
        intervalMs: 1_000,
        now: () => 0,
        onError: (err) => errors.push(err),
      });

      await vi.advanceTimersByTimeAsync(2_500);
      // Still running after the first failure: the batch is retried on
      // the next pass, with its watermark still held.
      expect(errors).toHaveLength(2);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
