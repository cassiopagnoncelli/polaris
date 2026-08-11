import type { AnalyticsQueueRow, AnalyticsSinkWriter } from "@polaris/shared-clickhouse";
import {
  DeferredCheckpointStore,
  InMemoryCheckpointStore,
  type PolarisConsumer,
  type TransportMessagePayload,
} from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { SinkMetrics } from "../src/metrics.js";
import { createRuntime, toQueueRow } from "../src/runtime.js";

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => silentLogger,
} as unknown as Parameters<typeof createRuntime>[0]["logger"];

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "evt-1",
    event: "page_viewed",
    schema_version: 1,
    project_id: "project-alpha",
    environment: "production",
    occurred_at: "2026-08-01T10:00:00.000Z",
    ingested_at: "2026-08-01T10:00:01.000Z",
    source: { id: "web-app" },
    identity: { customer_id: "cust-1" },
    context: { page: { url: "https://example.com" } },
    consent: { marketing: true },
    privacy: {},
    properties: { sku: "abc" },
    processor: { name: "analytics-projector", version: "v1" },
    _version: 1234,
    ...overrides,
  };
}

function payload(
  body: unknown,
  overrides: Partial<TransportMessagePayload> = {},
): TransportMessagePayload {
  return {
    stream: "analytics.events-2",
    family: "analytics.events",
    partition: 2,
    message: {
      value: Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8"),
      key: "project-alpha:production:cust-1",
      headers: {},
      offset: "42",
      timestamp: "1760000000000",
      redelivered: false,
    },
    ...overrides,
  } as TransportMessagePayload;
}

function fakeWriter(): { writer: AnalyticsSinkWriter; batches: AnalyticsQueueRow[][] } {
  const batches: AnalyticsQueueRow[][] = [];
  return {
    batches,
    writer: {
      async insertBatch(rows) {
        batches.push([...rows]);
      },
      async close() {},
    },
  };
}

const noopConsumer: PolarisConsumer = {
  async subscribe() {},
  async runEach() {},
  async disconnect() {},
  streams: [],
  queues: [],
};

function runtimeWith(
  writer: AnalyticsSinkWriter,
  overrides: {
    batchMaxRows?: number;
    batchMaxMs?: number;
    now?: () => number;
    checkpoints?: DeferredCheckpointStore;
  } = {},
) {
  return createRuntime({
    consumer: noopConsumer,
    writer,
    logger: silentLogger,
    metrics: new SinkMetrics(),
    batchMaxRows: overrides.batchMaxRows ?? 3,
    batchMaxMs: overrides.batchMaxMs ?? 60_000,
    checkpoints:
      overrides.checkpoints ?? new DeferredCheckpointStore(new InMemoryCheckpointStore()),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}

describe("toQueueRow", () => {
  it("projects the envelope and stamps transport lineage", () => {
    const row = toQueueRow(payload(envelope()), silentLogger);

    expect(row).toMatchObject({
      event_id: "evt-1",
      event: "page_viewed",
      schema_version: 1,
      project_id: "project-alpha",
      environment: "production",
      occurred_at: "2026-08-01T10:00:00.000Z",
      processor_name: "analytics-projector",
      processor_version: "v1",
      _version: 1234,
      // These were Kafka Engine virtual columns; the sink stamps them now.
      _topic: "analytics.events-2",
      _partition: 2,
      _offset: 42,
    });
  });

  it("serializes nested envelope objects as JSON strings", () => {
    const row = toQueueRow(payload(envelope()), silentLogger);
    expect(JSON.parse(String(row?.identity))).toEqual({ customer_id: "cust-1" });
    expect(JSON.parse(String(row?.properties))).toEqual({ sku: "abc" });
  });

  it("renders an absent nested object as empty string, not 'null'", () => {
    const row = toQueueRow(payload(envelope({ consent: undefined })), silentLogger);
    // A literal 'null' would make downstream JSONExtract calls see a null
    // document rather than an absent one.
    expect(row?.consent).toBe("");
  });

  it("defaults _version to 0 so the MV fallback applies", () => {
    const row = toQueueRow(payload(envelope({ _version: undefined })), silentLogger);
    expect(row?._version).toBe(0);
  });

  it("skips an undecodable payload rather than throwing", () => {
    // Throwing would rewind the partition and re-deliver the same broken
    // message forever, stalling every healthy event behind it.
    expect(toQueueRow(payload("{not json"), silentLogger)).toBeUndefined();
  });

  it("skips a payload missing required envelope fields", () => {
    expect(toQueueRow(payload({ event_id: "e" }), silentLogger)).toBeUndefined();
  });

  it("skips an empty message body", () => {
    const empty = payload(envelope());
    const withNull = {
      ...empty,
      message: { ...empty.message, value: null },
    } as TransportMessagePayload;
    expect(toQueueRow(withNull, silentLogger)).toBeUndefined();
  });
});

describe("clickhouse sink runtime batching", () => {
  it("buffers rows until the row bound trips", async () => {
    const { writer, batches } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 3 });

    await runtime.handler(payload(envelope({ event_id: "e1" })), {});
    await runtime.handler(payload(envelope({ event_id: "e2" })), {});
    expect(batches).toHaveLength(0);
    expect(runtime.pending).toBe(2);

    await runtime.handler(payload(envelope({ event_id: "e3" })), {});
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((r) => r.event_id)).toEqual(["e1", "e2", "e3"]);
    expect(runtime.pending).toBe(0);
  });

  it("flushes a partial batch when the time bound trips", async () => {
    const { writer, batches } = fakeWriter();
    let clock = 1_000;
    const runtime = runtimeWith(writer, {
      batchMaxRows: 100,
      batchMaxMs: 2_000,
      now: () => clock,
    });

    await runtime.handler(payload(envelope({ event_id: "e1" })), {});
    expect(batches).toHaveLength(0);

    clock += 5_000;
    await runtime.handler(payload(envelope({ event_id: "e2" })), {});
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("awaits the insert before returning, so the checkpoint cannot outrun the write", async () => {
    // The transport advances the offset only after the handler resolves.
    // If the flush were fire-and-forget, a crash would checkpoint past
    // rows ClickHouse never received.
    let resolveInsert: (() => void) | undefined;
    let inserted = false;
    const writer: AnalyticsSinkWriter = {
      async insertBatch() {
        await new Promise<void>((resolve) => {
          resolveInsert = () => {
            inserted = true;
            resolve();
          };
        });
      },
      async close() {},
    };
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });

    const pending = runtime.handler(payload(envelope()), {});
    expect(inserted).toBe(false);
    resolveInsert?.();
    await pending;
    expect(inserted).toBe(true);
  });

  it("does not lose a delivery that lands during an in-flight insert", async () => {
    const batches: AnalyticsQueueRow[][] = [];
    let release: (() => void) | undefined;
    const writer: AnalyticsSinkWriter = {
      async insertBatch(rows) {
        batches.push([...rows]);
        if (batches.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      async close() {},
    };
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });

    const first = runtime.handler(payload(envelope({ event_id: "e1" })), {});
    const second = runtime.handler(payload(envelope({ event_id: "e2" })), {});
    release?.();
    await Promise.all([first, second]);

    const all = batches.flat().map((r) => r.event_id);
    expect(all).toEqual(["e1", "e2"]);
  });

  it("skips unusable messages without buffering them", async () => {
    const { writer, batches } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 2 });

    await runtime.handler(payload("{broken"), {});
    await runtime.handler(payload(envelope({ event_id: "e1" })), {});
    expect(batches).toHaveLength(0);
    expect(runtime.pending).toBe(1);
  });

  it("flush is a no-op on an empty batch", async () => {
    const { writer, batches } = fakeWriter();
    const runtime = runtimeWith(writer);
    await runtime.flush();
    expect(batches).toHaveLength(0);
  });
});

describe("SinkMetrics", () => {
  it("reports ingestion lag from the envelope's ingested_at", () => {
    const metrics = new SinkMetrics();
    const ingestedAt = "2026-08-01T10:00:00.000Z";
    metrics.recordLag(ingestedAt, Date.parse(ingestedAt) + 4_500);

    const sample = metrics
      .getSamples()
      .find((s) => s.name === "polaris_clickhouse_sink_lag_seconds");
    expect(sample?.value).toBeCloseTo(4.5, 3);
    expect(sample?.labels).toEqual({ table: "analytics_events_queue" });
  });

  it("ignores an unparsable timestamp instead of reporting a huge lag", () => {
    const metrics = new SinkMetrics();
    metrics.recordLag("not-a-date", Date.now());
    const sample = metrics
      .getSamples()
      .find((s) => s.name === "polaris_clickhouse_sink_lag_seconds");
    // Paging someone because one message had a malformed timestamp is a
    // worse failure than under-reporting lag for that message.
    expect(sample?.value).toBe(0);
  });

  it("counts consumed rows per project and environment", () => {
    const metrics = new SinkMetrics();
    metrics.recordConsumed("project-alpha", "production");
    metrics.recordConsumed("project-alpha", "production");
    metrics.recordConsumed("project-beta", "staging");

    const consumed = metrics
      .getSamples()
      .filter((s) => s.name === "polaris_clickhouse_sink_rows_consumed_total");
    expect(consumed).toHaveLength(2);
    expect(consumed.find((s) => s.labels["project_id"] === "project-alpha")?.value).toBe(2);
  });
});

describe("checkpoint safety", () => {
  it("does not let the checkpoint advance past rows that are only buffered", async () => {
    // The transport advances a stream's checkpoint as soon as the handler
    // resolves. The sink's handler resolves WITHOUT inserting whenever the
    // batch bounds have not tripped, so with the shipped defaults
    // (batchMaxRows=1000, checkpointEvery=500) a crash discards up to a
    // thousand rows the checkpoint already claims were handled — silent
    // loss on the one path that has no upstream retry.
    const { writer, batches } = fakeWriter();
    const underlying = new InMemoryCheckpointStore();
    const deferred = new DeferredCheckpointStore(underlying);
    const runtime = createRuntime({
      consumer: noopConsumer,
      writer,
      logger: silentLogger,
      metrics: new SinkMetrics(),
      batchMaxRows: 3,
      batchMaxMs: 60_000,
      checkpoints: deferred,
    });

    // Two rows buffered, nothing inserted. The transport would have
    // written a checkpoint by now; it must not reach the durable store.
    await runtime.handler(payload(envelope({ event_id: "e1" })), {});
    await deferred.write({ group_name: "sink", stream: "analytics.events-2", last_offset: "1" });
    await runtime.handler(payload(envelope({ event_id: "e2" })), {});
    await deferred.write({ group_name: "sink", stream: "analytics.events-2", last_offset: "2" });

    expect(batches).toHaveLength(0);
    expect(await underlying.read("sink", "analytics.events-2")).toBeUndefined();

    // The third row trips the bound; once ClickHouse has acknowledged the
    // insert, the held positions become durable.
    await runtime.handler(payload(envelope({ event_id: "e3" })), {});
    await deferred.write({ group_name: "sink", stream: "analytics.events-2", last_offset: "3" });

    expect(batches).toHaveLength(1);
    // Durable at 2, not 3: the transport writes a message's checkpoint
    // AFTER its handler returns, so the position of the row that
    // triggered the flush lands in the next batch's window. The lag is
    // one message and it errs the safe way — a crash re-reads offset 3
    // and ReplacingMergeTree collapses the duplicate.
    expect(await underlying.read("sink", "analytics.events-2")).toBe("2");
  });

  it("keeps the checkpoint pinned when the insert fails", async () => {
    const underlying = new InMemoryCheckpointStore();
    await underlying.write({
      group_name: "sink",
      stream: "analytics.events-2",
      last_offset: "10",
    });
    const deferred = new DeferredCheckpointStore(underlying);
    const runtime = createRuntime({
      consumer: noopConsumer,
      writer: {
        async insertBatch() {
          throw new Error("clickhouse 503");
        },
        async close() {},
      },
      logger: silentLogger,
      metrics: new SinkMetrics(),
      batchMaxRows: 1,
      batchMaxMs: 60_000,
      checkpoints: deferred,
    });

    await expect(runtime.handler(payload(envelope({ event_id: "e1" })), {})).rejects.toThrow(
      /clickhouse 503/,
    );
    await expect(
      deferred.write({ group_name: "sink", stream: "analytics.events-2", last_offset: "11" }),
    ).resolves.toBeUndefined();

    // Still at the pre-batch position, so the rows are re-read.
    expect(await underlying.read("sink", "analytics.events-2")).toBe("10");
  });

  it("flushes and commits the position on clean shutdown", async () => {
    const { writer, batches } = fakeWriter();
    const underlying = new InMemoryCheckpointStore();
    const deferred = new DeferredCheckpointStore(underlying);
    const runtime = createRuntime({
      consumer: noopConsumer,
      writer,
      logger: silentLogger,
      metrics: new SinkMetrics(),
      batchMaxRows: 1000,
      batchMaxMs: 60_000,
      checkpoints: deferred,
    });
    await runtime.start();

    await runtime.handler(payload(envelope({ event_id: "e1" })), {});
    await deferred.write({ group_name: "sink", stream: "analytics.events-2", last_offset: "7" });
    expect(await underlying.read("sink", "analytics.events-2")).toBeUndefined();

    await runtime.stop();
    expect(batches).toHaveLength(1);
    expect(await underlying.read("sink", "analytics.events-2")).toBe("7");
  });
});
