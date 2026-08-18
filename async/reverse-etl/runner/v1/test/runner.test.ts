/**
 * The runner's two load-bearing properties: a rerun is free, and one bad
 * row never fails a run.
 */

import type { ReverseEtlJob, ReverseEtlRow } from "@polaris/reverse-etl-catalog";
import { describe, expect, it } from "vitest";

import { type IngestBatchResult, runReverseEtl } from "../src/runner.js";

const JOB: ReverseEtlJob = {
  key: "test_job",
  version: 1,
  description: "test",
  sql: "SELECT customer_id, v FROM polaris.profile_event_daily_counts",
  toEvent(row: ReverseEtlRow) {
    const customerId = row["customer_id"];
    if (typeof customerId !== "string" || customerId.length === 0) return null;
    return { event: "user.identified" as const, customerId, properties: { v: row["v"] } };
  },
};

/** Stands in for the platform's UUIDv5 derivation: same inputs, same id. */
function deriveId(input: {
  job: string;
  version: number;
  customerId: string;
  properties: Readonly<Record<string, unknown>>;
}): string {
  return `${input.job}:${String(input.version)}:${input.customerId}:${JSON.stringify(input.properties)}`;
}

function recordingIngest(result?: Partial<IngestBatchResult>) {
  const batches: Array<readonly Record<string, unknown>[]> = [];
  return {
    batches,
    client: {
      send: async (events: readonly Record<string, unknown>[]) => {
        batches.push([...events]);
        return {
          accepted: result?.accepted ?? events.length,
          rejected: result?.rejected ?? 0,
          rejectedReasons: result?.rejectedReasons ?? [],
        };
      },
    },
  };
}

function run(rows: readonly ReverseEtlRow[], overrides: { batchSize?: number } = {}) {
  const ingest = recordingIngest();
  return {
    ingest,
    result: runReverseEtl({
      job: JOB,
      projectId: "storefront",
      environment: "production",
      query: { run: async () => rows },
      ingest: ingest.client,
      runId: "polaris_rtl_1",
      now: () => new Date("2026-08-17T03:00:00.000Z"),
      batchSize: overrides.batchSize ?? 100,
      deriveId,
    }),
  };
}

describe("runReverseEtl", () => {
  it("derives the same event id for an unchanged row, so a rerun is absorbed", async () => {
    // The property a cron needs: run it twice by accident and nothing
    // happens. Deriving from the RUN would make an hourly job emit the
    // same fact twenty-four times a day.
    const rows = [{ customer_id: "cus_1", v: 5 }];
    const first = run(rows);
    await first.result;
    const second = run(rows);
    await second.result;

    expect(first.ingest.batches[0]?.[0]?.["event_id"]).toBe(
      second.ingest.batches[0]?.[0]?.["event_id"],
    );
  });

  it("derives a different id when the value changed, so the new value flows", async () => {
    const before = run([{ customer_id: "cus_1", v: 5 }]);
    await before.result;
    const after = run([{ customer_id: "cus_1", v: 9 }]);
    await after.result;

    expect(before.ingest.batches[0]?.[0]?.["event_id"]).not.toBe(
      after.ingest.batches[0]?.[0]?.["event_id"],
    );
  });

  it("stamps source.type internal, which is the loop-safety marker", async () => {
    const { ingest, result } = run([{ customer_id: "cus_1", v: 1 }]);
    await result;

    expect(ingest.batches[0]?.[0]?.["source"]).toEqual({
      id: "reverse-etl/test_job",
      type: "internal",
    });
  });

  it("dates the fact from the RUN, not from the underlying rows", async () => {
    // "As of now, lifetime orders are N". Dating it from the newest order
    // would claim the aggregate was true then, when later orders had not
    // happened yet.
    const { ingest, result } = run([{ customer_id: "cus_1", v: 1 }]);
    await result;

    expect(ingest.batches[0]?.[0]?.["occurred_at"]).toBe("2026-08-17T03:00:00.000Z");
  });

  it("skips an unmappable row and counts it, rather than failing the run", async () => {
    const { result } = run([{ customer_id: "cus_1", v: 1 }, { customer_id: "", v: 2 }, { v: 3 }]);
    const outcome = await result;

    expect(outcome.rowsRead).toBe(3);
    expect(outcome.rowsSkipped).toBe(2);
    expect(outcome.eventsSent).toBe(1);
  });

  it("batches by the configured size", async () => {
    const rows = Array.from({ length: 5 }, (_unused, i) => ({
      customer_id: `c${String(i)}`,
      v: i,
    }));
    const { ingest, result } = run(rows, { batchSize: 2 });
    await result;

    expect(ingest.batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("carries rejection reasons into the result, deduped, never payloads", async () => {
    const ingest = recordingIngest({
      accepted: 0,
      rejected: 2,
      rejectedReasons: ["forbidden_field_rejected", "forbidden_field_rejected", "unknown_event"],
    });
    const outcome = await runReverseEtl({
      job: JOB,
      projectId: "storefront",
      environment: "production",
      query: { run: async () => [{ customer_id: "cus_1", v: 1 }] },
      ingest: ingest.client,
      runId: "polaris_rtl_1",
      now: () => new Date("2026-08-17T03:00:00.000Z"),
      batchSize: 100,
      deriveId,
    });

    expect(outcome.eventsRejected).toBe(2);
    expect(outcome.rejectedReasons).toEqual(["forbidden_field_rejected", "unknown_event"]);
  });

  it("sends nothing when the query returns nothing", async () => {
    const { ingest, result } = run([]);
    const outcome = await result;

    expect(ingest.batches).toEqual([]);
    expect(outcome.eventsSent).toBe(0);
  });
});
