/**
 * Behavioural tests for the `processor_dlq_records` typed repository
 * (3L2HKMND) plus the `publishToDlq` dual-write integration.
 *
 * Tests use the in-memory adapter; the Kysely adapter mirrors the
 * same contract so it shares the same behavioural surface.
 */
import { describe, expect, it } from "vitest";

import { publishToDlq } from "../src/dlq.js";
import {
  InMemoryProcessorDlqRecordRepository,
  type ProcessorDlqRecord,
} from "../src/db/processor-dlq-records.js";

const PROCESSOR_NAME = "analytics-projector";
const PROCESSOR_VERSION = "v1";

function fixtureEnvelope() {
  return {
    event_id: "evt_01HZZ00000000000000000000A",
    event_name: "page.viewed",
    project_id: "storefront",
    environment: "production",
  } as const;
}

function fixturePayload(headers: Record<string, string | Buffer> = {}) {
  return {
    topic: "raw.events",
    partition: 0,
    message: {
      key: Buffer.from("storefront.production.user.1"),
      value: Buffer.from(JSON.stringify({ event: "page.viewed" })),
      headers,
      offset: "42",
      timestamp: "0",
      attributes: 0,
      size: 0,
    },
    heartbeat: async () => {},
    pause: () => () => {},
  };
}

function fakeProducer() {
  const sent: Array<{ topic: string }> = [];
  return {
    sent,
    producer: {
      connect: async () => undefined,
      disconnect: async () => undefined,
      isConnected: () => true,
      send: async (record: { topic: string }) => {
        sent.push({ topic: record.topic });
        return [];
      },
      sendBatch: async () => [],
    } as unknown as Parameters<typeof publishToDlq>[0]["producer"],
  };
}

describe("InMemoryProcessorDlqRecordRepository", () => {
  it("records and reads back a single DLQ row", async () => {
    const repo = new InMemoryProcessorDlqRecordRepository({
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    });
    const record = await repo.recordDlq({
      processor_name: PROCESSOR_NAME,
      processor_version: PROCESSOR_VERSION,
      event_id: "evt_a",
      event_name: "page.viewed",
      project_id: "storefront",
      environment: "production",
      attempts: 3,
      reason: "unknown_error",
      error_class: "TypeError",
      error_message: "cannot read property of undefined",
      source_topic: "raw.events",
      source_partition: 0,
      source_offset: "42",
      headers: { "x-foo": "bar" },
      payload: Buffer.from("envelope-bytes"),
    });
    expect(record.dlq_id).toMatch(/^polaris_pdlq_/);
    expect(record.resolved_at).toBeNull();
    expect(record.published_at).toEqual(new Date("2026-05-16T12:00:00.000Z"));

    const fetched = await repo.findRecord(record.dlq_id);
    expect(fetched?.event_id).toBe("evt_a");
    expect(fetched?.payload).toEqual(Buffer.from("envelope-bytes"));
  });

  it("findByProcessor narrows to unresolved by default, newest first", async () => {
    const t = (iso: string) => new Date(iso);
    const repo = new InMemoryProcessorDlqRecordRepository();
    const a = await repo.recordDlq(
      seed({ event_id: "evt_a", published_at: t("2026-05-13T00:00:00Z") }),
    );
    const b = await repo.recordDlq(
      seed({ event_id: "evt_b", published_at: t("2026-05-14T00:00:00Z") }),
    );
    await repo.markResolved(a.dlq_id, "operator-1", null);
    const rows = await repo.findByProcessor(PROCESSOR_NAME);
    expect(rows.map((r) => r.event_id)).toEqual(["evt_b"]);
    const withResolved = await repo.findByProcessor(PROCESSOR_NAME, { includeResolved: true });
    expect(withResolved.map((r) => r.event_id)).toEqual(["evt_b", "evt_a"]);
    expect(b.dlq_id).not.toBe(a.dlq_id);
  });

  it("markResolved is idempotent", async () => {
    const repo = new InMemoryProcessorDlqRecordRepository();
    const record = await repo.recordDlq(seed());
    const first = await repo.markResolved(record.dlq_id, "operator-1", "fixed");
    expect(first.applied).toBe(true);
    expect(first.record.resolved_by).toBe("operator-1");
    expect(first.record.resolution_note).toBe("fixed");

    const second = await repo.markResolved(record.dlq_id, "operator-2", "second pass");
    expect(second.applied).toBe(false);
    // First-write-wins: original resolver + note preserved.
    expect(second.record.resolved_by).toBe("operator-1");
    expect(second.record.resolution_note).toBe("fixed");
  });

  it("rejects unknown dlq_ids on markResolved", async () => {
    const repo = new InMemoryProcessorDlqRecordRepository();
    await expect(
      repo.markResolved("polaris_pdlq_does-not-exist", "operator-1", null),
    ).rejects.toThrow(/unknown dlq_id/);
  });
});

describe("publishToDlq — dual-write (3L2HKMND)", () => {
  it("writes a processor_dlq_records row alongside the Kafka publish when supplied", async () => {
    const repo = new InMemoryProcessorDlqRecordRepository();
    const { producer, sent } = fakeProducer();
    await publishToDlq({
      producer,
      identity: { name: PROCESSOR_NAME, version: PROCESSOR_VERSION },
      payload: fixturePayload({ "x-trace-id": "trace-1" }),
      error: new TypeError("cannot read property of undefined"),
      dlqRecords: repo,
      envelope: fixtureEnvelope(),
      attempts: 3,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.topic).toBe(`${PROCESSOR_NAME}.dlq`);

    const rows = repo.snapshot();
    expect(rows).toHaveLength(1);
    const row = rows[0] as ProcessorDlqRecord;
    expect(row.processor_name).toBe(PROCESSOR_NAME);
    expect(row.processor_version).toBe(PROCESSOR_VERSION);
    expect(row.event_id).toBe("evt_01HZZ00000000000000000000A");
    expect(row.attempts).toBe(3);
    expect(row.error_class).toBe("TypeError");
    expect(row.error_message).toBe("cannot read property of undefined");
    expect(row.source_topic).toBe("raw.events");
    expect(row.source_offset).toBe("42");
    expect(row.headers["x-trace-id"]).toBe("trace-1");
    expect(row.payload).not.toBeNull();
  });

  it("does NOT write a row when no repository is supplied (back-compat)", async () => {
    const { producer, sent } = fakeProducer();
    await publishToDlq({
      producer,
      identity: { name: PROCESSOR_NAME, version: PROCESSOR_VERSION },
      payload: fixturePayload(),
      error: new Error("boom"),
    });
    expect(sent).toHaveLength(1);
  });

  it("Kafka publish succeeds even when the row write throws", async () => {
    const failures: unknown[] = [];
    const breakingRepo: InMemoryProcessorDlqRecordRepository =
      new InMemoryProcessorDlqRecordRepository();
    // Monkey-patch recordDlq to throw, then verify the helper still
    // returns the Kafka result and surfaces the row-write failure
    // via the onRowFailure hook.
    breakingRepo.recordDlq = async () => {
      throw new Error("postgres unavailable");
    };
    const { producer, sent } = fakeProducer();
    await publishToDlq({
      producer,
      identity: { name: PROCESSOR_NAME, version: PROCESSOR_VERSION },
      payload: fixturePayload(),
      error: new Error("handler crashed"),
      dlqRecords: breakingRepo,
      envelope: fixtureEnvelope(),
      onRowFailure: (err) => failures.push(err),
    });
    expect(sent).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});

function seed(overrides: Partial<Parameters<InMemoryProcessorDlqRecordRepository["recordDlq"]>[0]> = {}) {
  return {
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    event_id: "evt_x",
    event_name: "page.viewed",
    project_id: "storefront",
    environment: "production" as const,
    attempts: 1,
    reason: "unknown_error",
    source_topic: "raw.events",
    source_partition: 0,
    source_offset: "10",
    ...overrides,
  };
}
