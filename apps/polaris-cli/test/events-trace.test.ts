/**
 * `polaris events trace` (V3L2TLWC).
 *
 * The command's whole job is to be readable when parts of the pipeline
 * are missing, so most of these tests are absence tests: a rejected
 * event, a pre-R2 topology with no lineage, an event nobody delivered.
 * The happy path is the easy case.
 */

import type { IngestLogTraceRow, ViolationRow } from "@polaris/persistence-clickhouse";
import type { DeliveryRecord, DlqRecord } from "@polaris/delivery-destinations";
import { describe, expect, it } from "vitest";

import {
  buildEventsTraceRunner,
  type CommandContext,
  type EventsTraceArgs,
  type EventsTraceStore,
  type EventTrace,
  type OutputStreams,
  UsageError,
} from "../src/index.js";

const EVENT_ID = "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551";

function capture(): { streams: OutputStreams; stdout: string[] } {
  const stdout: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: () => {},
    },
    stdout,
  };
}

function makeContext(streams: OutputStreams, format: "human" | "json" = "json"): CommandContext {
  const noop = () => {};
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: format,
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: {
      fatal: noop,
      error: noop,
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
    } as unknown as CommandContext["logger"],
    output: streams,
    env: {},
    actor: { source: "cli", label: "tester" },
  } as unknown as CommandContext;
}

function ingestRow(overrides: Partial<IngestLogTraceRow> = {}): IngestLogTraceRow {
  return {
    event_id: EVENT_ID,
    event: "page.viewed",
    schema_version: 2,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-08-15T12:00:00.000Z",
    ingested_at: "2026-08-15T12:00:01.000Z",
    _consumed_at: "2026-08-15T12:00:02.000Z",
    processor_name: "identity-resolver",
    processor_version: "v2",
    _topic: "resolved.events-0",
    _partition: 0,
    _offset: "4242",
    ...overrides,
  };
}

function violationRow(overrides: Partial<ViolationRow> = {}): ViolationRow {
  return {
    violation_id: "polaris_vio_1",
    project_id: "storefront",
    environment: "production",
    event: "purchase",
    event_id: EVENT_ID,
    reason: "forbidden_field_rejected",
    paths: ["properties.cvv"],
    redacted_sample: '{"properties":{"cvv":"[REDACTED:pii_card]"}}',
    received_at: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

function deliveryRow(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    delivery_id: "polaris_del_1",
    destination_id: "polaris_dst_1",
    event_id: EVENT_ID,
    event_name: "page.viewed",
    project_id: "storefront",
    environment: "production",
    consumer_version: "v1",
    consumer_build_version: null,
    config_version: null,
    normalize_version: "v1",
    mapper_version: "v1",
    deliverer_version: "v1",
    attempt: 1,
    status: "delivered",
    error_class: null,
    vendor_response_code: "200",
    vendor_response_summary: "ok",
    dedupe_key: null,
    started_at: new Date("2026-08-15T12:00:03.000Z"),
    finished_at: new Date("2026-08-15T12:00:03.500Z"),
    ...overrides,
  } as DeliveryRecord;
}

function dlqRow(overrides: Partial<DlqRecord> = {}): DlqRecord {
  return {
    dlq_id: "polaris_dlq_1",
    destination_id: "polaris_dst_1",
    event_id: EVENT_ID,
    event_name: "page.viewed",
    project_id: "storefront",
    environment: "production",
    vendor: "meta-capi",
    consumer_version: "v1",
    normalize_version: "v1",
    mapper_version: "v1",
    deliverer_version: "v1",
    attempts: 5,
    reason: "max_attempts_exhausted",
    error_class: "vendor_5xx",
    vendor_response_code: "503",
    vendor_response_summary: "upstream unavailable",
    delivery_key: null,
    source_topic: "resolved.events-0",
    source_partition: 0,
    source_offset: "4242",
    headers: {},
    payload: Buffer.from('{"properties":{"email":"shopper@example.com"}}', "utf8"),
    published_at: new Date("2026-08-15T12:05:00.000Z"),
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    ...overrides,
  } as DlqRecord;
}

interface StoreShape {
  ingestLog?: readonly IngestLogTraceRow[];
  violations?: readonly ViolationRow[];
  deliveries?: readonly DeliveryRecord[];
  dlq?: readonly DlqRecord[];
}

function storeReturning(shape: StoreShape) {
  let closed = 0;
  const seen: EventsTraceArgs[] = [];
  const store: EventsTraceStore = {
    ingestLog: async (args) => {
      seen.push(args);
      return shape.ingestLog ?? [];
    },
    violations: async () => shape.violations ?? [],
    deliveries: async () => shape.deliveries ?? [],
    dlq: async () => shape.dlq ?? [],
    close: async () => {
      closed += 1;
    },
  };
  return { store, seen, closedCount: () => closed };
}

async function runTrace(shape: StoreShape, args: Partial<EventsTraceArgs> = {}) {
  const { streams, stdout } = capture();
  const ctx = makeContext(streams);
  const { store, seen, closedCount } = storeReturning(shape);
  const runner = buildEventsTraceRunner({ openStore: () => store });
  await runner({ eventId: EVENT_ID, project: "storefront", ...args }, ctx);
  const parsed = JSON.parse(stdout.join("")) as { trace: EventTrace };
  return { trace: parsed.trace, seen, closedCount, stdout };
}

describe("events trace — argument validation", () => {
  it("rejects an empty event id", async () => {
    const { streams } = capture();
    const runner = buildEventsTraceRunner({ openStore: () => storeReturning({}).store });
    await expect(
      runner({ eventId: "   ", project: "storefront" }, makeContext(streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects an empty project", async () => {
    const { streams } = capture();
    const runner = buildEventsTraceRunner({ openStore: () => storeReturning({}).store });
    await expect(
      runner({ eventId: EVENT_ID, project: "  " }, makeContext(streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects a non-positive limit", async () => {
    const { streams } = capture();
    const runner = buildEventsTraceRunner({ openStore: () => storeReturning({}).store });
    await expect(
      runner({ eventId: EVENT_ID, project: "storefront", limit: 0 }, makeContext(streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("errors when no store has heard of the event", async () => {
    const { streams } = capture();
    const runner = buildEventsTraceRunner({ openStore: () => storeReturning({}).store });
    await expect(
      runner({ eventId: EVENT_ID, project: "storefront" }, makeContext(streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("closes the store even when the event is not found", async () => {
    const { streams } = capture();
    const { store, closedCount } = storeReturning({});
    const runner = buildEventsTraceRunner({ openStore: () => store });
    await expect(
      runner({ eventId: EVENT_ID, project: "storefront" }, makeContext(streams)),
    ).rejects.toBeInstanceOf(UsageError);
    expect(closedCount()).toBe(1);
  });
});

describe("events trace — a complete journey", () => {
  it("reports every stage as present", async () => {
    const { trace } = await runTrace({
      ingestLog: [ingestRow()],
      deliveries: [deliveryRow()],
    });
    expect(trace.found).toBe(true);
    expect(trace.quarantine.presence).toBe("absent");
    expect(trace.ingest_log.presence).toBe("present");
    expect(trace.deliveries.presence).toBe("present");
    expect(trace.dlq.presence).toBe("absent");
  });

  it("carries the transport lineage and the processor stamp", async () => {
    const { trace } = await runTrace({ ingestLog: [ingestRow()] });
    const row = trace.ingest_log.rows[0];
    expect(row?._topic).toBe("resolved.events-0");
    expect(row?._offset).toBe("4242");
    expect(row?.processor_name).toBe("identity-resolver");
    expect(row?.processor_version).toBe("v2");
  });

  it("passes the project and environment through to the ingest-log read", async () => {
    const { seen } = await runTrace(
      { ingestLog: [ingestRow()] },
      { environment: "production", limit: 10 },
    );
    expect(seen[0]?.project).toBe("storefront");
    expect(seen[0]?.environment).toBe("production");
    expect(seen[0]?.limit).toBe(10);
  });

  it("closes the store", async () => {
    const { closedCount } = await runTrace({ ingestLog: [ingestRow()] });
    expect(closedCount()).toBe(1);
  });
});

describe("events trace — partial data prints as absent, not as an error", () => {
  it("explains an absent lineage for a rejected event", async () => {
    // The pre-fix operator experience: an event that never got in has no
    // rows anywhere downstream, and four empty command outputs do not
    // say why.
    const { trace } = await runTrace({ violations: [violationRow()] });
    expect(trace.found).toBe(true);
    expect(trace.quarantine.presence).toBe("present");
    expect(trace.ingest_log.presence).toBe("absent");
    expect(trace.ingest_log.note).toContain("rejected at ingest");
    expect(trace.deliveries.note).toContain("rejected at ingest");
  });

  it("distinguishes a not-rejected event with no lineage from a rejected one", async () => {
    // A pre-R2 topology, or an event younger than the sink's lag.
    const { trace } = await runTrace({ deliveries: [deliveryRow()] });
    expect(trace.quarantine.presence).toBe("absent");
    expect(trace.ingest_log.presence).toBe("absent");
    expect(trace.ingest_log.note).toContain("retention window");
    expect(trace.ingest_log.note).not.toContain("rejected");
  });

  it("always states the retention bound", async () => {
    const { trace } = await runTrace({ ingestLog: [ingestRow()] });
    expect(trace.retention_note).toContain("30 days");
    expect(trace.retention_note).toContain("aged out");
  });
});

describe("events trace — payloads never leave the DLQ table", () => {
  it("omits the DLQ payload from the JSON output", async () => {
    const { trace, stdout } = await runTrace({ dlq: [dlqRow()] });
    const row = trace.dlq.rows[0];
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("payload");
    expect(row).not.toHaveProperty("headers");
    // The raw address in the fixture payload must not appear anywhere in
    // what the command printed. `--output json` bypasses the human
    // renderer, so filtering there would not have caught this.
    expect(stdout.join("")).not.toContain("shopper@example.com");
  });

  it("keeps the triage fields an operator actually needs", async () => {
    const { trace } = await runTrace({ dlq: [dlqRow()] });
    const row = trace.dlq.rows[0];
    expect(row?.dlq_id).toBe("polaris_dlq_1");
    expect(row?.attempts).toBe(5);
    expect(row?.reason).toBe("max_attempts_exhausted");
    expect(row?.vendor).toBe("meta-capi");
    expect(row?.source_offset).toBe("4242");
  });

  it("reports a resolved DLQ record rather than hiding it", async () => {
    const { trace } = await runTrace({
      dlq: [dlqRow({ resolved_at: new Date("2026-08-15T13:00:00.000Z"), resolved_by: "cassio" })],
    });
    expect(trace.dlq.presence).toBe("present");
    expect(trace.dlq.rows[0]?.resolved_at).toBe("2026-08-15T13:00:00.000Z");
    expect(trace.dlq.rows[0]?.resolved_by).toBe("cassio");
  });

  it("omits the redacted sample from the quarantine stage", async () => {
    const { trace, stdout } = await runTrace({ violations: [violationRow()] });
    const row = trace.quarantine.rows[0];
    expect(row).not.toHaveProperty("redacted_sample");
    expect(stdout.join("")).not.toContain("REDACTED:pii_card");
    // The paths survive — they are what makes the rejection actionable.
    expect(row?.paths).toEqual(["properties.cvv"]);
  });
});

describe("events trace — human output", () => {
  it("names every section even when the stage is absent", async () => {
    const { streams, stdout } = capture();
    const { store } = storeReturning({ ingestLog: [ingestRow()] });
    const runner = buildEventsTraceRunner({ openStore: () => store });
    await runner({ eventId: EVENT_ID, project: "storefront" }, makeContext(streams, "human"));
    const text = stdout.join("");
    expect(text).toContain("INGEST");
    expect(text).toContain("TRANSPORT + PROCESSORS");
    expect(text).toContain("DELIVERIES");
    expect(text).toContain("DLQ");
    expect(text).toContain("absent");
  });

  it("marks a rejected event as REJECTED at the top", async () => {
    const { streams, stdout } = capture();
    const { store } = storeReturning({ violations: [violationRow()] });
    const runner = buildEventsTraceRunner({ openStore: () => store });
    await runner({ eventId: EVENT_ID, project: "storefront" }, makeContext(streams, "human"));
    expect(stdout.join("")).toContain("INGEST: REJECTED");
  });
});
