/**
 * Behavioral tests for the `dlq_records` repository.
 *
 * Pins:
 *
 *   - recordDlq inserts a row with sane defaults (id prefix, timestamps)
 *   - findRecord returns null on miss, the row on hit
 *   - findByDestinationId / findByVendor honour the filter knobs
 *     (errorClass, reason, since/until, includeResolved, limit)
 *   - markResolved is idempotent: first call applies, second reports applied=false
 *   - markResolved throws on unknown id
 *   - resolution_note is clamped to the schema's max length
 *   - dlq_id is allocated with the polaris_dlq_ prefix
 *
 * @see libs/delivery/destinations/src/db/dlq-records.ts
 * @see db/postgres/migrations/20260514000001_create_dlq_records.sql
 */

import { describe, expect, it } from "vitest";

import {
  DLQ_RECORD_ID_PREFIX,
  DLQ_RESOLUTION_NOTE_MAX_LENGTH,
  InMemoryDlqRecordRepository,
  LIST_DLQ_RECORDS_HARD_LIMIT,
  type RecordDlqInput,
} from "../src/index.js";

function baseInput(overrides: Partial<RecordDlqInput> = {}): RecordDlqInput {
  return {
    destination_id: "polaris_dst_test_meta",
    event_id: "evt_dlq_001",
    event_name: "payment.approved",
    project_id: "storefront",
    environment: "production",
    vendor: "meta-capi",
    consumer_version: "v1",
    normalize_version: "v1",
    mapper_version: "v1",
    deliverer_version: "v1",
    attempts: 3,
    reason: "permanent",
    error_class: "permanent",
    vendor_response_code: "400",
    vendor_response_summary: "vendor rejected the event",
    delivery_key: "polaris_del_test001",
    source_topic: "analytics.events",
    source_partition: 0,
    source_offset: "12345",
    headers: { "polaris-destination-id": "polaris_dst_test_meta" },
    payload: Buffer.from('{"event":"payment.approved"}'),
    ...overrides,
  };
}

describe("InMemoryDlqRecordRepository.recordDlq", () => {
  it("allocates a polaris_dlq_<uuidv7> id when none is supplied", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const row = await repo.recordDlq(baseInput());
    expect(row.dlq_id.startsWith(DLQ_RECORD_ID_PREFIX)).toBe(true);
    expect(row.dlq_id.length).toBeGreaterThan(DLQ_RECORD_ID_PREFIX.length);
  });

  it("preserves the supplied id when given", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const row = await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_explicit" });
    expect(row.dlq_id).toBe("polaris_dlq_explicit");
  });

  it("stamps published_at to `now()` when omitted", async () => {
    const fixed = new Date("2026-05-14T12:00:00.000Z");
    const repo = new InMemoryDlqRecordRepository({ now: () => fixed });
    const row = await repo.recordDlq(baseInput());
    expect(row.published_at.toISOString()).toBe("2026-05-14T12:00:00.000Z");
    expect(row.resolved_at).toBeNull();
    expect(row.resolved_by).toBeNull();
    expect(row.resolution_note).toBeNull();
  });

  it("clones the headers map (subsequent caller mutation does not leak)", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const headers = { foo: "bar" };
    const row = await repo.recordDlq({ ...baseInput(), headers });
    headers.foo = "mutated";
    expect(row.headers["foo"]).toBe("bar");
  });
});

describe("InMemoryDlqRecordRepository.findRecord", () => {
  it("returns null when the id is unknown", async () => {
    const repo = new InMemoryDlqRecordRepository();
    expect(await repo.findRecord("polaris_dlq_unknown")).toBeNull();
  });

  it("returns the persisted row on hit", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const inserted = await repo.recordDlq(baseInput());
    const found = await repo.findRecord(inserted.dlq_id);
    expect(found?.dlq_id).toBe(inserted.dlq_id);
    expect(found?.event_id).toBe(inserted.event_id);
  });
});

describe("InMemoryDlqRecordRepository.findByEventId", () => {
  it("returns an empty list for an event nobody dead-lettered", async () => {
    const repo = new InMemoryDlqRecordRepository();
    expect(await repo.findByEventId("evt_never_failed")).toEqual([]);
  });

  it("returns every destination that dead-lettered the same event", async () => {
    // One event can be dead-lettered independently by several
    // destinations, which is why this returns a list rather than a row.
    const repo = new InMemoryDlqRecordRepository();
    await repo.recordDlq(baseInput({ destination_id: "polaris_dst_meta" }));
    await repo.recordDlq(baseInput({ destination_id: "polaris_dst_ga4" }));
    await repo.recordDlq(baseInput({ event_id: "evt_other" }));

    const rows = await repo.findByEventId("evt_dlq_001");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.destination_id).sort()).toEqual([
      "polaris_dst_ga4",
      "polaris_dst_meta",
    ]);
  });

  it("includes resolved records", async () => {
    // `polaris events trace` reports history, not a work queue. Hiding a
    // resolved row would report the event as having sailed through.
    const repo = new InMemoryDlqRecordRepository();
    const inserted = await repo.recordDlq(baseInput());
    await repo.markResolved(inserted.dlq_id, "cassio", "vendor config fixed");

    const rows = await repo.findByEventId("evt_dlq_001");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolved_at).not.toBeNull();
    expect(rows[0]?.resolved_by).toBe("cassio");
  });
});

describe("InMemoryDlqRecordRepository.findByDestinationId", () => {
  it("returns only the rows matching destination_id, newest first", async () => {
    const repo = new InMemoryDlqRecordRepository();
    await repo.recordDlq({
      ...baseInput(),
      dlq_id: "polaris_dlq_old",
      destination_id: "polaris_dst_meta",
      published_at: new Date("2026-05-13T00:00:00.000Z"),
    });
    await repo.recordDlq({
      ...baseInput(),
      dlq_id: "polaris_dlq_new",
      destination_id: "polaris_dst_meta",
      published_at: new Date("2026-05-14T00:00:00.000Z"),
    });
    await repo.recordDlq({
      ...baseInput(),
      dlq_id: "polaris_dlq_other",
      destination_id: "polaris_dst_other",
      published_at: new Date("2026-05-14T01:00:00.000Z"),
    });
    const rows = await repo.findByDestinationId("polaris_dst_meta");
    expect(rows.map((r) => r.dlq_id)).toEqual(["polaris_dlq_new", "polaris_dlq_old"]);
  });

  it("filters out resolved rows by default", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const a = await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_a" });
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_b" });
    await repo.markResolved(a.dlq_id, "cli", null);
    const unresolved = await repo.findByDestinationId("polaris_dst_test_meta");
    expect(unresolved.map((r) => r.dlq_id)).toEqual(["polaris_dlq_b"]);
  });

  it("includeResolved=true returns both resolved and unresolved", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const a = await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_a" });
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_b" });
    await repo.markResolved(a.dlq_id, "cli", null);
    const all = await repo.findByDestinationId("polaris_dst_test_meta", { includeResolved: true });
    expect(all.map((r) => r.dlq_id).sort()).toEqual(["polaris_dlq_a", "polaris_dlq_b"]);
  });

  it("narrows by errorClass when supplied", async () => {
    const repo = new InMemoryDlqRecordRepository();
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_auth", error_class: "auth" });
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_perm", error_class: "permanent" });
    const auth = await repo.findByDestinationId("polaris_dst_test_meta", { errorClass: "auth" });
    expect(auth.map((r) => r.dlq_id)).toEqual(["polaris_dlq_auth"]);
  });

  it("narrows by reason when supplied", async () => {
    const repo = new InMemoryDlqRecordRepository();
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_auth", reason: "auth" });
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_perm", reason: "permanent" });
    const auth = await repo.findByDestinationId("polaris_dst_test_meta", { reason: "auth" });
    expect(auth.map((r) => r.dlq_id)).toEqual(["polaris_dlq_auth"]);
  });

  it("narrows by since/until window (half-open)", async () => {
    const repo = new InMemoryDlqRecordRepository();
    await repo.recordDlq({
      ...baseInput(),
      dlq_id: "polaris_dlq_before",
      published_at: new Date("2026-05-13T00:00:00.000Z"),
    });
    await repo.recordDlq({
      ...baseInput(),
      dlq_id: "polaris_dlq_in",
      published_at: new Date("2026-05-14T00:00:00.000Z"),
    });
    await repo.recordDlq({
      ...baseInput(),
      dlq_id: "polaris_dlq_after",
      published_at: new Date("2026-05-15T00:00:00.000Z"),
    });
    const rows = await repo.findByDestinationId("polaris_dst_test_meta", {
      since: new Date("2026-05-14T00:00:00.000Z"),
      until: new Date("2026-05-15T00:00:00.000Z"),
    });
    expect(rows.map((r) => r.dlq_id)).toEqual(["polaris_dlq_in"]);
  });

  it("respects the limit, capped at LIST_DLQ_RECORDS_HARD_LIMIT", async () => {
    const repo = new InMemoryDlqRecordRepository();
    for (let i = 0; i < 5; i += 1) {
      await repo.recordDlq({
        ...baseInput(),
        dlq_id: `polaris_dlq_${i}`,
        published_at: new Date(2026, 4, 14, 0, i),
      });
    }
    const two = await repo.findByDestinationId("polaris_dst_test_meta", { limit: 2 });
    expect(two).toHaveLength(2);
    // Caps:
    expect(LIST_DLQ_RECORDS_HARD_LIMIT).toBe(1000);
  });
});

describe("InMemoryDlqRecordRepository.findByVendor", () => {
  it("matches on vendor, not destination_id", async () => {
    const repo = new InMemoryDlqRecordRepository();
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_meta1", vendor: "meta-capi" });
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_meta2", vendor: "meta-capi" });
    await repo.recordDlq({ ...baseInput(), dlq_id: "polaris_dlq_ga4", vendor: "ga4" });
    const rows = await repo.findByVendor("meta-capi");
    expect(rows.map((r) => r.dlq_id).sort()).toEqual(["polaris_dlq_meta1", "polaris_dlq_meta2"]);
  });
});

describe("InMemoryDlqRecordRepository.markResolved", () => {
  it("first call applies, second call reports already-resolved", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const row = await repo.recordDlq(baseInput());
    const first = await repo.markResolved(row.dlq_id, "cli@cassio", "retried by hand");
    expect(first.applied).toBe(true);
    expect(first.record.resolved_at).not.toBeNull();
    expect(first.record.resolved_by).toBe("cli@cassio");
    expect(first.record.resolution_note).toBe("retried by hand");
    const second = await repo.markResolved(row.dlq_id, "cli@other", "different note");
    expect(second.applied).toBe(false);
    // The original resolution_by survives — the second call does NOT overwrite.
    expect(second.record.resolved_by).toBe("cli@cassio");
    expect(second.record.resolution_note).toBe("retried by hand");
  });

  it("throws on unknown id", async () => {
    const repo = new InMemoryDlqRecordRepository();
    await expect(repo.markResolved("polaris_dlq_unknown", "cli", null)).rejects.toThrow(
      /not found/,
    );
  });

  it("clamps a very long resolution note", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const row = await repo.recordDlq(baseInput());
    const longNote = "x".repeat(DLQ_RESOLUTION_NOTE_MAX_LENGTH + 50);
    const outcome = await repo.markResolved(row.dlq_id, "cli", longNote);
    expect(outcome.record.resolution_note?.length).toBe(DLQ_RESOLUTION_NOTE_MAX_LENGTH);
    expect(outcome.record.resolution_note?.endsWith("…")).toBe(true);
  });

  it("accepts a null note and stores null", async () => {
    const repo = new InMemoryDlqRecordRepository();
    const row = await repo.recordDlq(baseInput());
    const outcome = await repo.markResolved(row.dlq_id, "cli", null);
    expect(outcome.record.resolution_note).toBeNull();
  });
});
