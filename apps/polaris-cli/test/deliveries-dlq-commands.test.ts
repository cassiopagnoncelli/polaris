/**
 * Behavioral tests for the P9-007 CLI surface:
 *
 *   - polaris deliveries list <destination_id>
 *   - polaris deliveries show <delivery_id>
 *   - polaris dlq list (--destination | --vendor)
 *   - polaris dlq show <dlq_id>
 *   - polaris dlq retry <dlq_id> [--note]
 *   - polaris dlq mark-resolved <dlq_id> [--note]
 *
 * Strategy: build each runner with `buildXyzRunner({ openStore: () => fake })`
 * and drive it directly. The default Kysely-backed store is exercised only
 * by integration tests; the runner-level test pins the orchestration:
 * filter parsing, output shape, audit hand-off, idempotency, secrets
 * absence, and the retry-then-mark-resolved transactional ordering.
 *
 * @see docs/implementation/tasks/P9-007-destination-dlq-triage.md
 */

import type { CommandContext, OutputStreams, PackageMeta } from "@polaris/polaris-cli";
import type { DeliveryRecord, DlqRecord } from "@polaris/shared-destinations";
import { describe, expect, it } from "vitest";

import { buildDeliveriesListRunner } from "../src/commands/deliveries/list.js";
import { buildDeliveriesShowRunner } from "../src/commands/deliveries/show.js";
import { buildDlqListRunner } from "../src/commands/dlq/list.js";
import {
  buildDlqMarkResolvedRunner,
  type DlqMarkResolvedAuditPayload,
} from "../src/commands/dlq/mark-resolved.js";
import {
  buildDlqRetryRunner,
  type DlqRetryAuditPayload,
  type RetryProducer,
} from "../src/commands/dlq/retry.js";
import { buildDlqShowRunner } from "../src/commands/dlq/show.js";
import { buildDlqSummaryRunner } from "../src/commands/dlq/summary.js";
import { UsageError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface Capture {
  readonly streams: OutputStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureOutput(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

const META: PackageMeta = {
  name: "polaris",
  version: "0.0.0-test",
  description: "test",
};

function makeContext(streams: OutputStreams): CommandContext {
  const noopLogger = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as CommandContext["logger"];
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: "human",
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: {
      ...noopLogger,
      child: () => noopLogger,
    } as CommandContext["logger"],
    output: streams,
    meta: META,
    actor: { source: "cli", label: "cli@test" },
  };
}

function jsonContext(streams: OutputStreams): CommandContext {
  const base = makeContext(streams);
  return { ...base, config: { ...base.config, output: "json" } };
}

function makeDeliveryRecord(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    delivery_id: "del_test_001",
    destination_id: "polaris_dst_meta",
    event_id: "evt_test_001",
    event_name: "payment.approved",
    project_id: "storefront",
    environment: "production",
    consumer_version: "v1",
    normalize_version: "v1",
    mapper_version: "v1",
    deliverer_version: "v1",
    attempt: 1,
    status: "accepted",
    error_class: null,
    vendor_response_code: "200",
    vendor_response_summary: "ok",
    dedupe_key: null,
    started_at: new Date("2026-05-14T12:00:00.000Z"),
    finished_at: new Date("2026-05-14T12:00:00.500Z"),
    ...overrides,
  };
}

function makeDlqRecord(overrides: Partial<DlqRecord> = {}): DlqRecord {
  return {
    dlq_id: "polaris_dlq_test_001",
    destination_id: "polaris_dst_meta",
    event_id: "evt_test_001",
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
    vendor_response_summary: "vendor rejected",
    delivery_key: "polaris_del_dedupe_001",
    source_topic: "analytics.events.shared",
    source_partition: 0,
    source_offset: "12345",
    headers: { "polaris-destination-id": "polaris_dst_meta" },
    payload: Buffer.from('{"event":"payment.approved"}', "utf8"),
    published_at: new Date("2026-05-14T12:00:01.000Z"),
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// polaris deliveries list
// ---------------------------------------------------------------------------

describe("polaris deliveries list", () => {
  it("returns the matching rows newest-first with human output", async () => {
    const rows = [makeDeliveryRecord({ delivery_id: "del_1" })];
    let closed = 0;
    const runner = buildDeliveriesListRunner({
      openStore: () => ({
        list: async () => rows,
        close: async () => {
          closed += 1;
        },
      }),
    });
    const capture = captureOutput();
    await runner({ destinationId: "polaris_dst_meta" }, makeContext(capture.streams));
    expect(closed).toBe(1);
    expect(capture.stdout.join("")).toContain("polaris_dst_meta");
    expect(capture.stdout.join("")).toContain("del_1");
    expect(capture.stdout.join("")).toContain("accepted");
  });

  it("emits structured json under --output json", async () => {
    const rows = [makeDeliveryRecord({ delivery_id: "del_json" })];
    const runner = buildDeliveriesListRunner({
      openStore: () => ({ list: async () => rows, close: async () => {} }),
    });
    const capture = captureOutput();
    await runner({ destinationId: "polaris_dst_meta" }, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.destination_id).toBe("polaris_dst_meta");
    expect(parsed.deliveries[0].delivery_id).toBe("del_json");
    // Secrets never appear in the row shape (schema-enforced).
    const flat = JSON.stringify(parsed);
    expect(flat).not.toMatch(/secret|token|bearer/i);
  });

  it("rejects an unknown --status with usage error", async () => {
    const runner = buildDeliveriesListRunner({
      openStore: () => ({ list: async () => [], close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(
      runner({ destinationId: "polaris_dst_meta", status: "bogus" }, makeContext(capture.streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects an unknown --error-class with usage error", async () => {
    const runner = buildDeliveriesListRunner({
      openStore: () => ({ list: async () => [], close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(
      runner(
        { destinationId: "polaris_dst_meta", errorClass: "made_up" },
        makeContext(capture.streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects a malformed --since with usage error", async () => {
    const runner = buildDeliveriesListRunner({
      openStore: () => ({ list: async () => [], close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(
      runner(
        { destinationId: "polaris_dst_meta", since: "not-a-date" },
        makeContext(capture.streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("forwards filter knobs to the store", async () => {
    let captured: Parameters<
      Parameters<typeof buildDeliveriesListRunner>[0]["openStore"] extends () => infer S
        ? S extends { list: (...args: infer A) => unknown }
          ? (...args: A) => unknown
          : never
        : never
    > | null = null;
    const runner = buildDeliveriesListRunner({
      openStore: () => ({
        list: async (...args) => {
          captured = args as never;
          return [];
        },
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await runner(
      {
        destinationId: "polaris_dst_meta",
        status: "failed_permanent",
        errorClass: "auth",
        since: "2026-05-13T00:00:00.000Z",
        until: "2026-05-14T00:00:00.000Z",
        limit: "50",
      },
      makeContext(capture.streams),
    );
    expect(captured).not.toBeNull();
    const [id, filter] = captured as unknown as [string, Record<string, unknown>];
    expect(id).toBe("polaris_dst_meta");
    expect(filter.status).toBe("failed_permanent");
    expect(filter.errorClass).toBe("auth");
    expect(filter.since).toBeInstanceOf(Date);
    expect(filter.until).toBeInstanceOf(Date);
    expect(filter.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// polaris deliveries show
// ---------------------------------------------------------------------------

describe("polaris deliveries show", () => {
  it("prints the row when found", async () => {
    const row = makeDeliveryRecord({ delivery_id: "del_show_1" });
    const runner = buildDeliveriesShowRunner({
      openStore: () => ({
        findById: async (id) => (id === "del_show_1" ? row : null),
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await runner({ deliveryId: "del_show_1" }, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("delivery_id");
    expect(capture.stdout.join("")).toContain("del_show_1");
    expect(capture.stdout.join("")).toContain("accepted");
  });

  it("throws UsageError when the id is unknown", async () => {
    const runner = buildDeliveriesShowRunner({
      openStore: () => ({ findById: async () => null, close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(
      runner({ deliveryId: "del_missing" }, makeContext(capture.streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

// ---------------------------------------------------------------------------
// polaris dlq list
// ---------------------------------------------------------------------------

describe("polaris dlq list", () => {
  it("requires exactly one of --destination or --vendor", async () => {
    const runner = buildDlqListRunner({
      openStore: () => ({ list: async () => [], close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(runner({}, makeContext(capture.streams))).rejects.toBeInstanceOf(UsageError);
    await expect(
      runner(
        { destination: "polaris_dst_meta", vendor: "meta-capi" },
        makeContext(capture.streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("scopes by destination when --destination is set", async () => {
    const rows = [makeDlqRecord()];
    let scope: unknown;
    const runner = buildDlqListRunner({
      openStore: () => ({
        list: async (s) => {
          scope = s;
          return rows;
        },
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await runner({ destination: "polaris_dst_meta" }, makeContext(capture.streams));
    expect(scope).toEqual({ kind: "destination", destination_id: "polaris_dst_meta" });
  });

  it("scopes by vendor when --vendor is set", async () => {
    const rows = [makeDlqRecord()];
    let scope: unknown;
    const runner = buildDlqListRunner({
      openStore: () => ({
        list: async (s) => {
          scope = s;
          return rows;
        },
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await runner({ vendor: "meta-capi" }, makeContext(capture.streams));
    expect(scope).toEqual({ kind: "vendor", vendor: "meta-capi" });
  });

  it("emits structured json with the scope reflected", async () => {
    const rows = [makeDlqRecord({ dlq_id: "polaris_dlq_a" })];
    const runner = buildDlqListRunner({
      openStore: () => ({ list: async () => rows, close: async () => {} }),
    });
    const capture = captureOutput();
    await runner({ vendor: "meta-capi" }, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.scope).toEqual({ vendor: "meta-capi" });
    expect(parsed.count).toBe(1);
    expect(parsed.dlq[0].dlq_id).toBe("polaris_dlq_a");
    expect(JSON.stringify(parsed)).not.toMatch(/secret|bearer|token/i);
  });

  it("rejects --error-class outside the closed set", async () => {
    const runner = buildDlqListRunner({
      openStore: () => ({ list: async () => [], close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(
      runner(
        { destination: "polaris_dst_meta", errorClass: "bogus" },
        makeContext(capture.streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

// ---------------------------------------------------------------------------
// polaris dlq show
// ---------------------------------------------------------------------------

describe("polaris dlq show", () => {
  it("prints headers + payload preview for an existing row", async () => {
    const row = makeDlqRecord({
      dlq_id: "polaris_dlq_show",
      payload: Buffer.from('{"event":"payment.approved","project_id":"storefront"}', "utf8"),
    });
    const runner = buildDlqShowRunner({
      openStore: () => ({
        findById: async (id) => (id === "polaris_dlq_show" ? row : null),
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await runner({ dlqId: "polaris_dlq_show" }, makeContext(capture.streams));
    const out = capture.stdout.join("");
    expect(out).toContain("polaris_dlq_show");
    expect(out).toContain("payment.approved");
    expect(out).toContain("payload_preview:");
    expect(out).toContain("headers:");
    // No secret echo in the output.
    expect(out).not.toMatch(/secret|bearer|token/i);
  });

  it("throws UsageError on unknown id", async () => {
    const runner = buildDlqShowRunner({
      openStore: () => ({ findById: async () => null, close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(
      runner({ dlqId: "polaris_dlq_missing" }, makeContext(capture.streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

// ---------------------------------------------------------------------------
// polaris dlq mark-resolved
// ---------------------------------------------------------------------------

describe("polaris dlq mark-resolved", () => {
  it("marks an unresolved row resolved and persists an audit row", async () => {
    const row = makeDlqRecord({ dlq_id: "polaris_dlq_unresolved" });
    let auditSeen: DlqMarkResolvedAuditPayload | null = null;
    let updateApplied = false;
    const runner = buildDlqMarkResolvedRunner({
      openStore: () => ({
        findById: async () => row,
        markResolvedWithAudit: async (_id, actorLabel, note, now, audit) => {
          auditSeen = audit;
          updateApplied = true;
          return {
            ...row,
            resolved_at: now,
            resolved_by: actorLabel,
            resolution_note: note,
          };
        },
        close: async () => {},
      }),
      now: () => new Date("2026-05-14T12:00:00.000Z"),
      generateAuditId: () => "audit-mark-1",
    });
    const capture = captureOutput();
    await runner(
      { dlqId: "polaris_dlq_unresolved", note: "fixed by hand" },
      makeContext(capture.streams),
    );
    expect(updateApplied).toBe(true);
    expect(auditSeen?.auditId).toBe("audit-mark-1");
    expect(auditSeen?.actorLabel).toBe("cli@test");
    expect(auditSeen?.note).toBe("fixed by hand");
    expect(capture.stdout.join("")).toContain("resolved polaris_dlq_unresolved");
  });

  it("is idempotent: an already-resolved row exits 0 with 'already resolved'", async () => {
    const row = makeDlqRecord({
      resolved_at: new Date("2026-05-14T00:00:00.000Z"),
      resolved_by: "cli@first",
    });
    let updateApplied = false;
    const runner = buildDlqMarkResolvedRunner({
      openStore: () => ({
        findById: async () => row,
        markResolvedWithAudit: async () => {
          updateApplied = true;
          return row;
        },
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await runner({ dlqId: "polaris_dlq_resolved" }, makeContext(capture.streams));
    expect(updateApplied).toBe(false);
    expect(capture.stdout.join("")).toContain("already resolved");
  });

  it("rejects --note over 1024 characters with usage error", async () => {
    const runner = buildDlqMarkResolvedRunner({
      openStore: () => ({
        findById: async () => null,
        markResolvedWithAudit: async () => makeDlqRecord(),
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await expect(
      runner({ dlqId: "polaris_dlq_test", note: "x".repeat(1025) }, makeContext(capture.streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("throws UsageError when the id is unknown", async () => {
    const runner = buildDlqMarkResolvedRunner({
      openStore: () => ({
        findById: async () => null,
        markResolvedWithAudit: async () => makeDlqRecord(),
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await expect(
      runner({ dlqId: "polaris_dlq_missing" }, makeContext(capture.streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

// ---------------------------------------------------------------------------
// polaris dlq retry
// ---------------------------------------------------------------------------

describe("polaris dlq retry", () => {
  function makeFakeProducer(): {
    producer: RetryProducer;
    sends: Array<{ topic: string; bodies: string[]; headers: Record<string, string>[] }>;
    connects: number;
    disconnects: number;
  } {
    const sends: Array<{ topic: string; bodies: string[]; headers: Record<string, string>[] }> = [];
    let connects = 0;
    let disconnects = 0;
    const producer: RetryProducer = {
      connect: async () => {
        connects += 1;
      },
      disconnect: async () => {
        disconnects += 1;
      },
      publishToQueue: async (record) => {
        sends.push({
          topic: record.queue,
          bodies: [record.value.toString("utf8")],
          headers: [{ ...(record.headers ?? {}) }],
        });
      },
    };
    return {
      producer,
      sends,
      get connects() {
        return connects;
      },
      get disconnects() {
        return disconnects;
      },
    };
  }

  it("republishes to the vendor redelivery queue, marks resolved, and writes an audit row", async () => {
    const row = makeDlqRecord({
      dlq_id: "polaris_dlq_retry_1",
      source_topic: "analytics.events.shared",
      payload: Buffer.from('{"event":"payment.approved"}', "utf8"),
      headers: { "polaris-delivery-key": "polaris_del_keep" },
    });
    const harness = makeFakeProducer();
    let auditSeen: DlqRetryAuditPayload | null = null;
    let markApplied = false;
    const runner = buildDlqRetryRunner({
      openStore: () => ({
        findById: async () => row,
        markResolvedWithAudit: async (_id, actorLabel, note, now, audit) => {
          auditSeen = audit;
          markApplied = true;
          return {
            ...row,
            resolved_at: now,
            resolved_by: actorLabel,
            resolution_note: note,
          };
        },
        close: async () => {},
      }),
      openProducer: async () => harness.producer,
      now: () => new Date("2026-05-14T12:30:00.000Z"),
      generateAuditId: () => "audit-retry-1",
    });
    const capture = captureOutput();
    await runner(
      { dlqId: "polaris_dlq_retry_1", note: "vendor fixed their bug" },
      makeContext(capture.streams),
    );
    // Producer was called exactly once, targeting the failing vendor's
    // redelivery queue rather than the source stream: republishing into
    // analytics.events would re-deliver the event to the ClickHouse sink
    // and every sibling destination too.
    expect(harness.connects).toBe(1);
    expect(harness.disconnects).toBe(1);
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]?.topic).toBe("meta-capi.redeliver");
    expect(harness.sends[0]?.bodies).toEqual(['{"event":"payment.approved"}']);
    expect(harness.sends[0]?.headers[0]?.["polaris-delivery-key"]).toBe("polaris_del_keep");
    // Resolution + audit landed.
    expect(markApplied).toBe(true);
    expect(auditSeen?.auditId).toBe("audit-retry-1");
    expect(auditSeen?.actorLabel).toBe("cli@test");
    expect(auditSeen?.note).toBe("vendor fixed their bug");
    expect(auditSeen?.republishedTopic).toBe("meta-capi.redeliver");
    expect(capture.stdout.join("")).toContain("retried polaris_dlq_retry_1");
  });

  it("does not republish when the row is already resolved", async () => {
    const row = makeDlqRecord({
      resolved_at: new Date("2026-05-14T00:00:00.000Z"),
      resolved_by: "cli@first",
    });
    const harness = makeFakeProducer();
    const runner = buildDlqRetryRunner({
      openStore: () => ({
        findById: async () => row,
        markResolvedWithAudit: async () => row,
        close: async () => {},
      }),
      openProducer: async () => harness.producer,
    });
    const capture = captureOutput();
    await runner({ dlqId: "polaris_dlq_test" }, makeContext(capture.streams));
    expect(harness.sends).toHaveLength(0);
    expect(capture.stdout.join("")).toContain("already resolved");
  });

  it("throws UsageError when the row has no payload bytes", async () => {
    const row = makeDlqRecord({ payload: null });
    const harness = makeFakeProducer();
    const runner = buildDlqRetryRunner({
      openStore: () => ({
        findById: async () => row,
        markResolvedWithAudit: async () => row,
        close: async () => {},
      }),
      openProducer: async () => harness.producer,
    });
    const capture = captureOutput();
    await expect(
      runner({ dlqId: "polaris_dlq_test" }, makeContext(capture.streams)),
    ).rejects.toBeInstanceOf(UsageError);
    expect(harness.sends).toHaveLength(0);
  });

  it("does NOT mark resolved when the republish fails", async () => {
    const row = makeDlqRecord();
    let markCalled = false;
    const runner = buildDlqRetryRunner({
      openStore: () => ({
        findById: async () => row,
        markResolvedWithAudit: async () => {
          markCalled = true;
          return row;
        },
        close: async () => {},
      }),
      openProducer: async () => ({
        connect: async () => {},
        disconnect: async () => {},
        publishToQueue: async () => {
          throw new Error("broker unavailable");
        },
      }),
    });
    const capture = captureOutput();
    await expect(
      runner({ dlqId: "polaris_dlq_test" }, makeContext(capture.streams)),
    ).rejects.toThrow(/broker unavailable/);
    // Mark-resolved must NOT have run — the row should stay unresolved so
    // the operator can retry.
    expect(markCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// polaris dlq summary (P10-006)
// ---------------------------------------------------------------------------

describe("polaris dlq summary", () => {
  it("requires exactly one of --destination or --vendor", async () => {
    const runner = buildDlqSummaryRunner({
      openStore: () => ({ list: async () => [], close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(runner({}, makeContext(capture.streams))).rejects.toBeInstanceOf(UsageError);
    await expect(
      runner(
        { destination: "polaris_dst_meta", vendor: "meta-capi" },
        makeContext(capture.streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("renders 'no dlq entries' when the scope is empty", async () => {
    const runner = buildDlqSummaryRunner({
      openStore: () => ({ list: async () => [], close: async () => {} }),
    });
    const capture = captureOutput();
    await runner({ vendor: "meta-capi" }, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("no dlq entries for vendor meta-capi");
  });

  it("aggregates rows by error_class and reason with counts and bounds", async () => {
    const rows: DlqRecord[] = [
      makeDlqRecord({
        dlq_id: "polaris_dlq_a",
        error_class: "auth",
        reason: "auth_failed",
        published_at: new Date("2026-05-14T08:00:00.000Z"),
      }),
      makeDlqRecord({
        dlq_id: "polaris_dlq_b",
        error_class: "auth",
        reason: "auth_failed",
        published_at: new Date("2026-05-14T10:00:00.000Z"),
      }),
      makeDlqRecord({
        dlq_id: "polaris_dlq_c",
        error_class: "permanent",
        reason: "vendor_400",
        published_at: new Date("2026-05-14T09:00:00.000Z"),
      }),
    ];
    const runner = buildDlqSummaryRunner({
      openStore: () => ({ list: async () => rows, close: async () => {} }),
    });
    const capture = captureOutput();
    await runner({ vendor: "meta-capi" }, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.scope).toEqual({ vendor: "meta-capi" });
    expect(parsed.total).toBe(3);
    expect(parsed.truncated).toBe(false);
    expect(parsed.oldest).toBe("2026-05-14T08:00:00.000Z");
    expect(parsed.newest).toBe("2026-05-14T10:00:00.000Z");
    // by_error_class is sorted by count desc, then label asc.
    expect(parsed.by_error_class).toEqual([
      {
        error_class: "auth",
        count: 2,
        oldest: "2026-05-14T08:00:00.000Z",
        newest: "2026-05-14T10:00:00.000Z",
      },
      {
        error_class: "permanent",
        count: 1,
        oldest: "2026-05-14T09:00:00.000Z",
        newest: "2026-05-14T09:00:00.000Z",
      },
    ]);
    expect(parsed.by_reason).toEqual([
      {
        reason: "auth_failed",
        count: 2,
        oldest: "2026-05-14T08:00:00.000Z",
        newest: "2026-05-14T10:00:00.000Z",
      },
      {
        reason: "vendor_400",
        count: 1,
        oldest: "2026-05-14T09:00:00.000Z",
        newest: "2026-05-14T09:00:00.000Z",
      },
    ]);
    // Defense: aggregate output must not echo secret-shaped strings.
    expect(JSON.stringify(parsed)).not.toMatch(/secret|bearer/i);
  });

  it("forwards scope and window filters to the store", async () => {
    let observedScope: unknown;
    let observedFilter: unknown;
    const runner = buildDlqSummaryRunner({
      openStore: () => ({
        list: async (scope, filter) => {
          observedScope = scope;
          observedFilter = filter;
          return [];
        },
        close: async () => {},
      }),
    });
    const capture = captureOutput();
    await runner(
      {
        destination: "polaris_dst_meta",
        since: "2026-05-14T00:00:00.000Z",
        until: "2026-05-15T00:00:00.000Z",
        includeResolved: true,
      },
      makeContext(capture.streams),
    );
    expect(observedScope).toEqual({
      kind: "destination",
      destination_id: "polaris_dst_meta",
    });
    expect(observedFilter).toEqual({
      since: new Date("2026-05-14T00:00:00.000Z"),
      until: new Date("2026-05-15T00:00:00.000Z"),
      includeResolved: true,
      limit: 1000,
    });
  });

  it("marks truncated=true when the result hits the 1000-row cap", async () => {
    const rows: DlqRecord[] = Array.from({ length: 1000 }, (_, idx) =>
      makeDlqRecord({
        dlq_id: `polaris_dlq_${idx}`,
        published_at: new Date(`2026-05-14T${String(idx % 24).padStart(2, "0")}:00:00.000Z`),
      }),
    );
    const runner = buildDlqSummaryRunner({
      openStore: () => ({ list: async () => rows, close: async () => {} }),
    });
    const capture = captureOutput();
    await runner({ vendor: "meta-capi" }, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.total).toBe(1000);
    expect(parsed.truncated).toBe(true);
  });

  it("rejects --since with a malformed ISO timestamp", async () => {
    const runner = buildDlqSummaryRunner({
      openStore: () => ({ list: async () => [], close: async () => {} }),
    });
    const capture = captureOutput();
    await expect(
      runner({ vendor: "meta-capi", since: "not-a-date" }, makeContext(capture.streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
