import {
  ANALYTICS_PROCESSED_QUEUE_TABLE,
  ANALYTICS_QUEUE_TABLE,
  type AnalyticsQueueRow,
  type AnalyticsSinkWriter,
  buildClickHouseVersion,
  PROFILE_EVENTS_QUEUE_TABLE,
  type ProfileEventQueueRow,
  type ViolationQueueRow,
} from "@polaris/persistence-clickhouse";
import {
  DeferredCheckpointStore,
  InMemoryCheckpointStore,
  type PolarisConsumer,
  type TransportMessagePayload,
} from "@polaris/bus";
import { describe, expect, it } from "vitest";

import { SinkMetrics } from "../src/metrics.js";
import { createRuntime, toQueueRow } from "../src/runtime.js";

/**
 * `_version = (stage_rank * 2^48) + ingested_at_ms`, and `resolved.events`
 * is rank 1. Spelled out rather than pasted as a literal so the scheme
 * stays readable; the default fixture family became `resolved.events` when
 * 126EPNIQ retired the rank-0 feed.
 */
const RESOLVED_RANK_BAND = 2 ** 48;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => silentLogger,
} as unknown as Parameters<typeof createRuntime>[0]["logger"];

/**
 * A logger that records the warn messages, for the two tests that care
 * whether a skip is loud or quiet.
 *
 * Pino-style: the message is the SECOND argument, after the fields object.
 */
function loggerCapturing(warnings: string[]) {
  const self: Record<string, unknown> = {
    debug: () => undefined,
    info: () => undefined,
    warn: (_fields: unknown, message?: string) => {
      warnings.push(message ?? "");
    },
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => self,
  };
  return self as unknown as Parameters<typeof createRuntime>[0]["logger"];
}

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
    stream: "resolved.events-2",
    family: "resolved.events",
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

interface RecordedBatch {
  readonly table: string;
  readonly rows: AnalyticsQueueRow[];
}

function fakeWriter(): {
  writer: AnalyticsSinkWriter;
  batches: AnalyticsQueueRow[][];
  writes: RecordedBatch[];
  violations: ViolationQueueRow[][];
  profileRows: ProfileEventQueueRow[][];
} {
  const batches: AnalyticsQueueRow[][] = [];
  const writes: RecordedBatch[] = [];
  const violations: ViolationQueueRow[][] = [];
  // Captured in their OWN shape. Recording them as AnalyticsQueueRow is how
  // the previous tests passed against a sink that wrote unusable rows: the
  // double accepted whatever the sink handed it, and the assertions only
  // ever read `table`.
  const profileRows: ProfileEventQueueRow[][] = [];
  return {
    batches,
    writes,
    violations,
    profileRows,
    writer: {
      async insertBatch(rows, table = ANALYTICS_QUEUE_TABLE) {
        batches.push([...rows]);
        writes.push({ table, rows: [...rows] });
      },
      async insertProfileEvents(rows) {
        profileRows.push([...rows]);
      },
      async insertViolations(rows) {
        violations.push([...rows]);
      },
      async close() {},
    },
  };
}

/** A delivery from one of the derived families. */
function derivedPayload(
  body: unknown,
  family = "session.events",
  partition = 1,
): TransportMessagePayload {
  return payload(body, {
    stream: `${family}-${String(partition)}`,
    family,
    partition,
  });
}

function derivedEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope({
    event: "session.started",
    source: { id: "sessionizer", type: "internal" },
    processor: { name: "sessionizer", version: "v1" },
    ...overrides,
  });
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
    logger?: Parameters<typeof createRuntime>[0]["logger"];
    metrics?: SinkMetrics;
  } = {},
) {
  return createRuntime({
    consumer: noopConsumer,
    writer,
    logger: overrides.logger ?? silentLogger,
    metrics: overrides.metrics ?? new SinkMetrics(),
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
      // Built from the family + ingested_at, not copied off the envelope
      // — see the dedicated test below.
      _version: RESOLVED_RANK_BAND + Date.parse("2026-08-01T10:00:01.000Z"),
      // These were Kafka Engine virtual columns; the sink stamps them now.
      _topic: "resolved.events-2",
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

  it("builds _version from the envelope's ingest time, not from a _version field", () => {
    // The sink used to read `envelope._version` and default to 0, which
    // meant EVERY row was 0 — nothing has ever set that field, and it is
    // not on the canonical envelope (a `.strict()` schema would reject
    // it). The MVs' ingest-ms fallback did all the work, and during the
    // M3 dual-run that fallback ties the two feeds.
    //
    // `_version` is now built here, from the producing family and the
    // envelope's own `ingested_at`. An envelope carrying a stray
    // `_version` no longer influences it.
    const body = envelope({ _version: 999 });
    const row = toQueueRow(payload(body), silentLogger);
    expect(row?._version).toBe(RESOLVED_RANK_BAND + Date.parse(String(body["ingested_at"])));
  });

  it("falls back to 0 for an unparseable ingest timestamp, so the MV guard catches it", () => {
    // 0 is the one value the MVs still rewrite. Better to hand the row
    // to that guard than to sort it to the bottom of its key forever.
    const row = toQueueRow(payload(envelope({ ingested_at: "not-a-timestamp" })), silentLogger);
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
      async insertProfileEvents() {},
      async insertViolations() {},
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
      async insertProfileEvents() {},
      async insertViolations() {},
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
  function lagFor(metrics: SinkMetrics, table: string) {
    return metrics
      .getSamples()
      .find((s) => s.name === "polaris_clickhouse_sink_lag_seconds" && s.labels["table"] === table);
  }

  it("reports ingestion lag from the envelope's ingested_at", () => {
    const metrics = new SinkMetrics();
    const ingestedAt = "2026-08-01T10:00:00.000Z";
    metrics.recordLag(ingestedAt, Date.parse(ingestedAt) + 4_500, ANALYTICS_QUEUE_TABLE);

    expect(lagFor(metrics, ANALYTICS_QUEUE_TABLE)?.value).toBeCloseTo(4.5, 3);
  });

  it("ignores an unparsable timestamp instead of reporting a huge lag", () => {
    const metrics = new SinkMetrics();
    metrics.recordLag("not-a-date", Date.now(), ANALYTICS_QUEUE_TABLE);
    // Paging someone because one message had a malformed timestamp is a
    // worse failure than under-reporting lag for that message.
    expect(lagFor(metrics, ANALYTICS_QUEUE_TABLE)?.value).toBe(0);
  });

  it("emits a lag series for both tables before either has seen a row", () => {
    // An absent series and a healthy-but-idle one look identical to
    // Prometheus, so the derived path must not go quiet just because it
    // has not received anything yet.
    const metrics = new SinkMetrics();
    expect(lagFor(metrics, ANALYTICS_QUEUE_TABLE)?.value).toBe(0);
    expect(lagFor(metrics, ANALYTICS_PROCESSED_QUEUE_TABLE)?.value).toBe(0);
  });

  it("tracks lag per table independently", () => {
    const metrics = new SinkMetrics();
    const ingestedAt = "2026-08-01T10:00:00.000Z";
    metrics.recordLag(ingestedAt, Date.parse(ingestedAt) + 1_000, ANALYTICS_QUEUE_TABLE);
    metrics.recordLag(ingestedAt, Date.parse(ingestedAt) + 9_000, ANALYTICS_PROCESSED_QUEUE_TABLE);

    expect(lagFor(metrics, ANALYTICS_QUEUE_TABLE)?.value).toBeCloseTo(1, 3);
    expect(lagFor(metrics, ANALYTICS_PROCESSED_QUEUE_TABLE)?.value).toBeCloseTo(9, 3);
  });

  it("counts consumed rows per project, environment and table", () => {
    const metrics = new SinkMetrics();
    metrics.recordConsumed("project-alpha", "production", ANALYTICS_QUEUE_TABLE);
    metrics.recordConsumed("project-alpha", "production", ANALYTICS_QUEUE_TABLE);
    metrics.recordConsumed("project-alpha", "production", ANALYTICS_PROCESSED_QUEUE_TABLE);
    metrics.recordConsumed("project-beta", "staging", ANALYTICS_QUEUE_TABLE);

    const consumed = metrics
      .getSamples()
      .filter((s) => s.name === "polaris_clickhouse_sink_rows_consumed_total");
    expect(consumed).toHaveLength(3);
    expect(
      consumed.find(
        (s) =>
          s.labels["project_id"] === "project-alpha" && s.labels["table"] === ANALYTICS_QUEUE_TABLE,
      )?.value,
    ).toBe(2);
    expect(consumed.find((s) => s.labels["table"] === ANALYTICS_PROCESSED_QUEUE_TABLE)?.value).toBe(
      1,
    );
  });
});

describe("derived-event routing", () => {
  it("routes derived families to the processed queue table", async () => {
    const { writer, writes } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });

    await runtime.handler(derivedPayload(derivedEnvelope({ event_id: "s1" })), {});

    expect(writes).toHaveLength(1);
    expect(writes[0]?.table).toBe(ANALYTICS_PROCESSED_QUEUE_TABLE);
    expect(writes[0]?.rows[0]?.event).toBe("session.started");
    // Lineage still names the concrete derived stream.
    expect(writes[0]?.rows[0]?._topic).toBe("session.events-1");
  });

  it.each([
    "session.events",
    "identity.events",
    "attribution.events",
  ])("routes %s to the processed queue table", async (family) => {
    const { writer, writes } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });

    await runtime.handler(derivedPayload(derivedEnvelope(), family), {});
    expect(writes[0]?.table).toBe(ANALYTICS_PROCESSED_QUEUE_TABLE);
  });

  it("keeps an isolated project's source events on the source table", async () => {
    // An isolated project reads `resolved.events.<project_id>`. Matching
    // the bare family alone would divert every isolated project's source
    // events into the derived table.
    const { writer, writes } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });

    await runtime.handler(
      payload(envelope(), {
        stream: "resolved.events.project-alpha-0",
        family: "resolved.events.project-alpha",
        partition: 0,
      }),
      {},
    );

    expect(writes[0]?.table).toBe(ANALYTICS_QUEUE_TABLE);
  });

  it("splits a mixed batch into one INSERT per table", async () => {
    const { writer, writes } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 3 });

    await runtime.handler(payload(envelope({ event_id: "e1" })), {});
    await runtime.handler(derivedPayload(derivedEnvelope({ event_id: "s1" })), {});
    expect(writes).toHaveLength(0);
    expect(runtime.pending).toBe(2);

    await runtime.handler(payload(envelope({ event_id: "e2" })), {});

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ table: ANALYTICS_QUEUE_TABLE });
    expect(writes[0]?.rows.map((r) => r.event_id)).toEqual(["e1", "e2"]);
    expect(writes[1]).toMatchObject({ table: ANALYTICS_PROCESSED_QUEUE_TABLE });
    expect(writes[1]?.rows.map((r) => r.event_id)).toEqual(["s1"]);
    expect(runtime.pending).toBe(0);
  });

  it("holds the checkpoint until BOTH inserts are acknowledged", async () => {
    // The deferred store holds positions for every stream the sink reads.
    // Committing after the first INSERT would advance the derived
    // families past rows still sitting in the second buffer.
    const writes: string[] = [];
    const underlying = new InMemoryCheckpointStore();
    const deferred = new DeferredCheckpointStore(underlying);
    const writer: AnalyticsSinkWriter = {
      async insertBatch(_rows, table = ANALYTICS_QUEUE_TABLE) {
        writes.push(table);
        if (table === ANALYTICS_QUEUE_TABLE) {
          // The derived rows are still buffered at this point.
          expect(await underlying.read("sink", "session.events-1")).toBeUndefined();
        }
      },
      async insertProfileEvents() {},
      async insertViolations() {},
      async close() {},
    };
    const runtime = runtimeWith(writer, { batchMaxRows: 2, checkpoints: deferred });

    await runtime.handler(payload(envelope({ event_id: "e1" })), {});
    await deferred.write({ group_name: "sink", stream: "resolved.events-2", last_offset: "1" });
    await runtime.handler(derivedPayload(derivedEnvelope({ event_id: "s1" })), {});
    await deferred.write({ group_name: "sink", stream: "session.events-1", last_offset: "5" });

    expect(writes).toEqual([ANALYTICS_QUEUE_TABLE, ANALYTICS_PROCESSED_QUEUE_TABLE]);
    expect(await underlying.read("sink", "resolved.events-2")).toBe("1");
  });

  it("rolls the checkpoint back when the derived insert fails after the source one", async () => {
    // Both batches are re-read. The source rows are then inserted twice
    // and ReplacingMergeTree collapses them — the same at-least-once
    // behaviour a crash mid-batch already produces.
    const underlying = new InMemoryCheckpointStore();
    await underlying.write({ group_name: "sink", stream: "session.events-1", last_offset: "4" });
    const deferred = new DeferredCheckpointStore(underlying);
    const runtime = runtimeWith(
      {
        async insertBatch(_rows, table = ANALYTICS_QUEUE_TABLE) {
          if (table === ANALYTICS_PROCESSED_QUEUE_TABLE) throw new Error("clickhouse 503");
        },
        async insertProfileEvents() {},
        async insertViolations() {},
        async close() {},
      },
      { batchMaxRows: 2, checkpoints: deferred },
    );

    await runtime.handler(payload(envelope({ event_id: "e1" })), {});
    await expect(
      runtime.handler(derivedPayload(derivedEnvelope({ event_id: "s1" })), {}),
    ).rejects.toThrow(/clickhouse 503/);

    expect(await underlying.read("sink", "session.events-1")).toBe("4");
  });

  it("subscribes to the source, derived AND profile families", async () => {
    const subscriptions: string[][] = [];
    const runtime = createRuntime({
      consumer: {
        async subscribe(input: { families: readonly string[] }) {
          subscriptions.push([...input.families]);
        },
        async runEach() {},
        async disconnect() {},
        streams: [],
        queues: [],
      } as unknown as PolarisConsumer,
      writer: fakeWriter().writer,
      logger: silentLogger,
      metrics: new SinkMetrics(),
      batchMaxRows: 10,
      batchMaxMs: 60_000,
      checkpoints: new DeferredCheckpointStore(new InMemoryCheckpointStore()),
    });

    await runtime.start();
    await runtime.stop();

    expect(subscriptions[0]).toEqual([
      "resolved.events",
      "session.events",
      "identity.events",
      "attribution.events",
      // The profile plane. Omitted from the subscription when the routing
      // branch landed, which meant the sink would have routed
      // `profile.events` correctly and never received any.
      "profile.events",
      // The quarantine, last and bare: it supports no isolation, so it
      // has no per-project variants to expand into.
      "rejected.events",
    ]);
  });

  it("includes each isolated project's dedicated family for every stream", async () => {
    const subscriptions: string[][] = [];
    const runtime = createRuntime({
      consumer: {
        async subscribe(input: { families: readonly string[] }) {
          subscriptions.push([...input.families]);
        },
        async runEach() {},
        async disconnect() {},
        streams: [],
        queues: [],
      } as unknown as PolarisConsumer,
      writer: fakeWriter().writer,
      logger: silentLogger,
      metrics: new SinkMetrics(),
      batchMaxRows: 10,
      batchMaxMs: 60_000,
      checkpoints: new DeferredCheckpointStore(new InMemoryCheckpointStore()),
      isolatedProjects: ["project-alpha"],
    });

    await runtime.start();
    await runtime.stop();

    expect(subscriptions[0]).toContain("resolved.events.project-alpha");
    expect(subscriptions[0]).toContain("session.events.project-alpha");
    // The profile plane isolates like every other family: an isolated
    // project's `profile.events.<id>` is still the profile plane, which is
    // what the prefix check in `isProfileEventFamily` relies on.
    expect(subscriptions[0]).toContain("profile.events.project-alpha");
    // Six families now: five isolate — shared + one dedicated each — and
    // the quarantine does not, so it contributes exactly one entry.
    // Was seven and fifteen until 126EPNIQ retired `analytics.events` and
    // the enriched family.
    expect(subscriptions[0]).toHaveLength(11);
    expect(subscriptions[0]).toContain("rejected.events");
    expect(subscriptions[0]).not.toContain("rejected.events.project-alpha");
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
    await deferred.write({ group_name: "sink", stream: "resolved.events-2", last_offset: "1" });
    await runtime.handler(payload(envelope({ event_id: "e2" })), {});
    await deferred.write({ group_name: "sink", stream: "resolved.events-2", last_offset: "2" });

    expect(batches).toHaveLength(0);
    expect(await underlying.read("sink", "resolved.events-2")).toBeUndefined();

    // The third row trips the bound; once ClickHouse has acknowledged the
    // insert, the held positions become durable.
    await runtime.handler(payload(envelope({ event_id: "e3" })), {});
    await deferred.write({ group_name: "sink", stream: "resolved.events-2", last_offset: "3" });

    expect(batches).toHaveLength(1);
    // Durable at 2, not 3: the transport writes a message's checkpoint
    // AFTER its handler returns, so the position of the row that
    // triggered the flush lands in the next batch's window. The lag is
    // one message and it errs the safe way — a crash re-reads offset 3
    // and ReplacingMergeTree collapses the duplicate.
    expect(await underlying.read("sink", "resolved.events-2")).toBe("2");
  });

  it("keeps the checkpoint pinned when the insert fails", async () => {
    const underlying = new InMemoryCheckpointStore();
    await underlying.write({
      group_name: "sink",
      stream: "resolved.events-2",
      last_offset: "10",
    });
    const deferred = new DeferredCheckpointStore(underlying);
    const runtime = createRuntime({
      consumer: noopConsumer,
      writer: {
        async insertBatch() {
          throw new Error("clickhouse 503");
        },
        async insertProfileEvents() {},
        async insertViolations() {},
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
      deferred.write({ group_name: "sink", stream: "resolved.events-2", last_offset: "11" }),
    ).resolves.toBeUndefined();

    // Still at the pre-batch position, so the rows are re-read.
    expect(await underlying.read("sink", "resolved.events-2")).toBe("10");
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
    await deferred.write({ group_name: "sink", stream: "resolved.events-2", last_offset: "7" });
    expect(await underlying.read("sink", "resolved.events-2")).toBeUndefined();

    await runtime.stop();
    expect(batches).toHaveLength(1);
    expect(await underlying.read("sink", "resolved.events-2")).toBe("7");
  });
});

describe("the _version storage format", () => {
  // Was "the dual-run: resolved.events alongside analytics.events". M3 put
  // the SAME event on two feeds at once; 126EPNIQ retired the legacy one,
  // so what remains here is the version scheme itself. The original notes
  // are kept because they explain WHY the scheme exists: two feeds shared
  // an event_id deliberately — two sightings of one fact, not two facts —
  // so they
  // share a sort key in `analytics_raw` and collapse into each other.
  // These tests pin the three things that make the collapse land on the
  // enriched row instead of a coin flip.

  it("routes resolved.events to the SOURCE table, not the derived one", async () => {
    // It carries the customer's event, enriched — not a fact ABOUT an
    // event. Landing it in analytics_processed would keep profile_id out
    // of analytics_raw entirely, which is the whole point of M3.
    const { writer, writes } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });

    await runtime.handler(
      payload(envelope(), { family: "resolved.events", stream: "resolved.events-0", partition: 0 }),
      {},
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.table).toBe(ANALYTICS_QUEUE_TABLE);
  });

  it("routes an isolated project's resolved family to the source table too", async () => {
    const { writer, writes } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });

    await runtime.handler(
      payload(envelope(), {
        family: "resolved.events.project-alpha",
        stream: "resolved.events.project-alpha-0",
        partition: 0,
      }),
      {},
    );

    expect(writes[0]?.table).toBe(ANALYTICS_QUEUE_TABLE);
  });

  it("counts a failed INSERT against the table it was writing", async () => {
    // The materialized-view failure signal. Polaris's MVs are plain
    // insert-triggered views and `materialized_views_ignore_errors` is 0,
    // so an MV whose SELECT throws fails the INSERT into its source table
    // and the exception arrives here. There is no MV "state" to poll --
    // `PolarisClickHouseMVFailure` polled `system.view_refreshes` for one
    // anyway and never produced a value in its entire life.
    const writes: string[] = [];
    const failing = {
      insertBatch: async (_rows: readonly AnalyticsQueueRow[], table?: string) => {
        writes.push(table ?? ANALYTICS_QUEUE_TABLE);
        throw new Error("Code: 341. DB::Exception: materialized view failed");
      },
      insertProfileEvents: async () => {},
      insertViolations: async () => {},
      close: async () => {},
    } as unknown as AnalyticsSinkWriter;

    const metrics = new SinkMetrics();
    const runtime = runtimeWith(failing, { batchMaxRows: 1, metrics });
    await expect(runtime.handler(payload(envelope()), {})).rejects.toThrow(/materialized view/);

    const sample = metrics
      .getSamples()
      .find(
        (s) =>
          s.name === "polaris_clickhouse_sink_insert_failures_total" &&
          s.labels["table"] === ANALYTICS_QUEUE_TABLE,
      );
    expect(sample?.value).toBe(1);
  });

  it("seeds every table's failure series at zero", () => {
    // Including `violations_queue`, which was absent from SINK_TABLES
    // while `recordBatch` was already being called with it -- so the
    // quarantine's lag gauge was never seeded either. An alert on
    // `increase(...) > 0` needs the series to exist before the first
    // failure, or a first failure and a scrape gap look the same.
    const names = new SinkMetrics()
      .getSamples()
      .filter((s) => s.name === "polaris_clickhouse_sink_insert_failures_total")
      .map((s) => s.labels["table"]);
    expect(names).toContain("violations_queue");
    expect(names).toHaveLength(4);
  });

  it("keeps the stage-rank ordering, though nothing produces rank 0 now", async () => {
    // The legacy feed is retired (126EPNIQ), so the dual-run this
    // originally asserted no longer happens. The RANK is a storage format,
    // not a coexistence device: changing one re-orders rows already merged
    // under the old value, so rank 0 stays reserved rather than reused.
    //
    // What still has to hold is that a source event's `_version` sits
    // above the bare ingest-ms a pre-scheme row carries -- that is what
    // makes ReplacingMergeTree pick the spine's row for the same event_id.
    const body = envelope();
    const resolved = toQueueRow(
      payload(body, { family: "resolved.events", stream: "resolved.events-0", partition: 0 }),
      silentLogger,
    ) as AnalyticsQueueRow;

    expect(resolved._version).toBeGreaterThan(Date.parse(String(body["ingested_at"])));
    // Still a safe integer: the scheme is only sound while it is.
    expect(Number.isSafeInteger(resolved._version)).toBe(true);
  });

  it("re-derives the same version on a replay, so reruns collapse instead of ratcheting", async () => {
    // Built from the envelope's ingested_at rather than the sink's clock.
    // A wall-clock version would make every replay outrank the original
    // and march the version forward on each rerun.
    const body = envelope();
    const first = toQueueRow(payload(body), silentLogger) as AnalyticsQueueRow;
    const replayed = toQueueRow(
      payload(body, {
        stream: "analytics.events-7",
        partition: 7,
        message: { ...payload(body).message, offset: "999" },
      }),
      silentLogger,
    ) as AnalyticsQueueRow;

    expect(replayed._version).toBe(first._version);
  });

  it("carries the profile block through to the queue row", async () => {
    const body = {
      ...envelope(),
      profile: {
        profile_id: "019ffe00-0000-7000-8000-00000000f001",
        canonical_customer_id: "cus_1",
        traits: { tier: "gold" },
        traits_version: 7,
      },
    };
    const row = toQueueRow(
      payload(body, { family: "resolved.events", stream: "resolved.events-0", partition: 0 }),
      silentLogger,
    ) as AnalyticsQueueRow;

    // The whole block travels: the MV extracts profile_id/traits_version
    // today, and reaching `traits` later should need no change here.
    expect(JSON.parse(row.profile)).toEqual(body.profile);
  });

  it('renders an absent profile as the empty string, not "null"', async () => {
    // Matches how every other optional block is rendered, and is what
    // makes JSONExtract downstream yield '' / 0 rather than parsing the
    // four-character document `null`.
    const row = toQueueRow(payload(envelope()), silentLogger) as AnalyticsQueueRow;
    expect(row.profile).toBe("");
  });

  it("agrees with the version helper the DDL comment documents", async () => {
    const body = envelope();
    const row = toQueueRow(
      payload(body, { family: "resolved.events", stream: "resolved.events-0", partition: 0 }),
      silentLogger,
    ) as AnalyticsQueueRow;

    expect(row._version).toBe(
      buildClickHouseVersion({ stage: "resolved", ingestedAt: String(body["ingested_at"]) }),
    );
  });
});

describe("clickhouse sink — profile-plane routing", () => {
  const PROBE_PROFILE_ID = "01a0155e-2ff0-73c0-b98d-928450ef0b45";

  function profilePayload(family: string): TransportMessagePayload {
    return payload(
      envelope({ event: "profile.updated", profile: { profile_id: PROBE_PROFILE_ID } }),
      { stream: `${family}-0`, family, partition: 0 },
    );
  }

  it("sends profile.events to its own queue AND to analytics_processed", async () => {
    // This asserted `not.toContain(ANALYTICS_PROCESSED_QUEUE_TABLE)` until
    // 2026-08-19, and in doing so pinned a hole the whole profile plane fell
    // through.
    //
    // The distinction it defended is real — a derived event records what
    // HAPPENED, `profile.updated` records what is now TRUE — but the
    // conclusion drawn from it was wrong. State and history are two
    // purposes, so they get two rows, not one row and a silent drop. The
    // profile queue's single materialized view filters
    // `event = 'profile.updated'`, so as the family's ONLY reader it
    // discarded `trait.computed`, `audience.entered`, `audience.exited` and
    // every `journey.*` — inside a Null table, with the INSERT reporting
    // success. The plan's own "traits history lives in ClickHouse" (§12) had
    // nowhere to live either.
    const { writer, writes, profileRows } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });
    await runtime.handler(profilePayload("profile.events"), {});

    // State: the reshaped row, on the profile writer.
    expect(profileRows.flat()).toHaveLength(1);
    // History: the full envelope, where every other derived fact lives.
    expect(writes.map((w) => w.table)).toContain(ANALYTICS_PROCESSED_QUEUE_TABLE);
    // Never the source table — that is for the spine.
    expect(writes.map((w) => w.table)).not.toContain(ANALYTICS_QUEUE_TABLE);
    // The profile writer is its own seam, so the queue table name never
    // appears in `writes`; the reshaped row above is the proof it was used.
    expect(writes.map((w) => w.table)).not.toContain(PROFILE_EVENTS_QUEUE_TABLE);
  });

  it("keeps a journey event out of the state path but in history", async () => {
    // `journey.step_advanced` names a profile but is not a trait change, so
    // it must not reach `polaris.profiles`. It must still be queryable — the
    // funnel guidance in 07-clickhouse.md reads exactly these rows out of
    // `analytics_processed`, and read zero of them before this.
    const { writer, writes, profileRows } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });
    await runtime.handler(
      payload(envelope({ event: "journey.step_advanced" }), {
        stream: "profile.events-0",
        family: "profile.events",
        partition: 0,
      }),
      {},
    );

    // No profile block on this fixture, so nothing reaches the state path...
    expect(profileRows.flat()).toHaveLength(0);
    // ...and the event still lands in history rather than evaporating.
    expect(writes.map((w) => w.table)).toContain(ANALYTICS_PROCESSED_QUEUE_TABLE);
  });

  it("writes the profile queue's OWN column shape, carrying profile_id", async () => {
    // The assertion this file was missing. Routing to the right table was
    // already asserted and already true; the row put there was an
    // AnalyticsQueueRow, whose keys `profile_events_queue` does not have.
    // ClickHouse dropped the unknown ones, defaulted `profile_id` to '',
    // and the materialized view discarded every row on `profile_id != ''`.
    // Rows consumed, batches inserted, `polaris.profiles` empty.
    const { writer, profileRows } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });
    await runtime.handler(profilePayload("profile.events"), {});

    const row = profileRows.flat()[0];
    expect(row?.profile_id).toBe(PROBE_PROFILE_ID);
    // Flat source columns, not the envelope's JSON block.
    expect(row).toHaveProperty("source_id");
    expect(row).toHaveProperty("source_type");
    expect(row).not.toHaveProperty("source");
    expect(row).not.toHaveProperty("identity");
    expect(row).not.toHaveProperty("profile");
  });

  it("skips a profile event whose envelope names no profile", async () => {
    // The MV drops these anyway, so inserting them would only make the
    // sink's row counter disagree with the table — which is exactly how
    // the bug above stayed invisible.
    const { writer, profileRows } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });
    await runtime.handler(
      payload(envelope({ event: "profile.updated" }), {
        stream: "profile.events-0",
        family: "profile.events",
        partition: 0,
      }),
      {},
    );

    expect(profileRows.flat()).toHaveLength(0);
  });

  it("WARNS about that skip, because it is data loss", async () => {
    // The skip above is correct and the warning is the point: a
    // `profile.updated` with no profile block means a producer is losing
    // trait writes. The identity stage shipped exactly that, and the line
    // below is the only thing that said so.
    const { writer } = fakeWriter();
    const warnings: string[] = [];
    const runtime = runtimeWith(writer, {
      batchMaxRows: 1,
      logger: loggerCapturing(warnings),
    });
    await runtime.handler(
      payload(envelope({ event: "profile.updated" }), {
        stream: "profile.events-0",
        family: "profile.events",
        partition: 0,
      }),
      {},
    );

    expect(warnings.join(" ")).toMatch(/carries no profile\.profile_id/);
  });

  it("stays SILENT for an event type that never names a person", async () => {
    // `trait.computed` is a run summary about a definition -- trait_key,
    // run_id, counts -- and there is no profile it could name. It rode the
    // same warn as the real loss above, one per definition per run, and
    // that routine noise is what kept the identity stage's actual data
    // loss unnoticed. An operator scanning a log full of expected warnings
    // does not see the unexpected one.
    const { writer, profileRows } = fakeWriter();
    const warnings: string[] = [];
    const runtime = runtimeWith(writer, {
      batchMaxRows: 1,
      logger: loggerCapturing(warnings),
    });
    await runtime.handler(
      payload(envelope({ event: "trait.computed" }), {
        stream: "profile.events-0",
        family: "profile.events",
        partition: 0,
      }),
      {},
    );

    expect(profileRows.flat()).toHaveLength(0);
    expect(warnings.join(" ")).not.toMatch(/carries no profile/);
  });

  it("routes an isolated project's profile family too", async () => {
    // Per-project isolation reads `<family>.<project_id>`, which is still
    // the profile plane. The prefix check is what puts an isolated project
    // in the same table as everyone else.
    const { writer, profileRows } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });
    await runtime.handler(profilePayload("profile.events.acme"), {});
    expect(profileRows.flat()).toHaveLength(1);
  });

  it("still routes derived families to analytics_processed", async () => {
    // The regression guard on the branch that changed shape: a third
    // destination added to the wrong side of a ternary is invisible.
    const { writer, writes } = fakeWriter();
    const runtime = runtimeWith(writer, { batchMaxRows: 1 });
    await runtime.handler(
      payload(envelope({ event: "session.started" }), {
        stream: "session.events-0",
        family: "session.events",
        partition: 0,
      }),
      {},
    );
    expect(writes.map((w) => w.table)).toContain(ANALYTICS_PROCESSED_QUEUE_TABLE);
  });
});

describe("the quarantine", () => {
  /** A delivery from `rejected.events`, carrying a violation record. */
  function violationDelivery(overrides: Record<string, unknown> = {}): TransportMessagePayload {
    return {
      stream: "rejected.events-0",
      family: "rejected.events",
      partition: 0,
      message: {
        value: Buffer.from(
          JSON.stringify({
            violation_version: 1,
            violation_id: "polaris_vio_1",
            project_id: "storefront",
            environment: "production",
            event: "purchase",
            event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            schema_version: 1,
            reason: "forbidden_field_rejected",
            paths: ["properties.cvv"],
            redacted_sample: '{"properties":{"cvv":"[REDACTED:pii_card]"}}',
            received_at: "2026-08-15T12:00:00.000Z",
            ...overrides,
          }),
          "utf8",
        ),
        headers: {},
        key: null,
        offset: "1",
        timestamp: "1755000000000",
        redelivered: false,
      },
    };
  }

  it("routes a violation to violations_queue, not to any envelope table", async () => {
    const fake = fakeWriter();
    const runtime = runtimeWith(fake.writer, { batchMaxRows: 1 });

    await runtime.handler(violationDelivery(), {});

    expect(fake.violations).toHaveLength(1);
    expect(fake.violations[0]?.[0]).toMatchObject({
      violation_id: "polaris_vio_1",
      reason: "forbidden_field_rejected",
      paths: ["properties.cvv"],
    });
    // Not in any of the three envelope tables — a violation is not an
    // envelope, and `toQueueRow` would have skipped it silently.
    expect(fake.writes).toHaveLength(0);
  });

  it("writes empty strings for hints the rejected payload never carried", async () => {
    const fake = fakeWriter();
    const runtime = runtimeWith(fake.writer, { batchMaxRows: 1 });

    await runtime.handler(
      violationDelivery({ event: null, event_id: null, schema_version: null }),
      {},
    );

    expect(fake.violations[0]?.[0]).toMatchObject({
      event: "",
      event_id: "",
      schema_version: 0,
    });
  });

  it("skips a payload that is not a violation record rather than stalling", async () => {
    // Throwing would rewind the partition and redeliver forever, stalling
    // the quarantine behind one bad record.
    const fake = fakeWriter();
    const runtime = runtimeWith(fake.writer, { batchMaxRows: 1 });

    await expect(
      runtime.handler(violationDelivery({ violation_id: 42, project_id: null }), {}),
    ).resolves.toBeUndefined();
    expect(fake.violations).toHaveLength(0);
  });

  it("counts violations toward the shared batch bound", async () => {
    // Every buffer counts. A quarantine excluded from the sum would sit
    // until the staleness timer regardless of volume.
    const fake = fakeWriter();
    const runtime = runtimeWith(fake.writer, { batchMaxRows: 2, batchMaxMs: 600_000 });

    await runtime.handler(violationDelivery(), {});
    expect(fake.violations).toHaveLength(0);
    await runtime.handler(violationDelivery({ violation_id: "polaris_vio_2" }), {});
    expect(fake.violations).toHaveLength(1);
    expect(fake.violations[0]).toHaveLength(2);
  });
});
