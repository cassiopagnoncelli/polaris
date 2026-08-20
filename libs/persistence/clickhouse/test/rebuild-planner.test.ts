/**
 * Behavioural tests for the ClickHouse rebuild planner (P7-005).
 *
 * The planner is a pure-function module — these tests inject a stub
 * `readPartitions` adapter and assert:
 *
 *   - every rejection code on the closed list fires under the
 *     corresponding malformed input,
 *   - the happy path renders a deterministic plan,
 *   - `system.parts` adapter failures map to `clickhouse_unreachable`
 *     (and do NOT escape as an unhandled throw),
 *   - the planner does not retain mutable references to the input.
 *
 * @see libs/persistence/clickhouse/src/rebuild/planner.ts
 * @see docs/implementation/tasks/P7-005-clickhouse-rebuild-workflows.md
 */

import { describe, expect, it } from "vitest";
import {
  CLICKHOUSE_REBUILD_REJECTION_CODES,
  type ClickhouseRebuildPlan,
  planClickhouseRebuild,
  REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES,
} from "../src/rebuild/index.js";

const NOW = new Date("2026-05-15T12:00:00.000Z");

interface AdapterCall {
  qualifiedTable: string;
  fromTs: Date | null;
  toTs: Date | null;
}

function stubAdapter(
  result:
    | { partitions: Array<{ partition: string; rowsEstimated: number }>; knownGaps?: string[] }
    | Error,
  recordedCalls?: AdapterCall[],
) {
  return async (input: { qualifiedTable: string; fromTs: Date | null; toTs: Date | null }) => {
    recordedCalls?.push({
      qualifiedTable: input.qualifiedTable,
      fromTs: input.fromTs,
      toTs: input.toTs,
    });
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
}

describe("planClickhouseRebuild — rejection codes", () => {
  it("closed-set is exactly these four codes", () => {
    expect(CLICKHOUSE_REBUILD_REJECTION_CODES).toEqual([
      "unknown_projection",
      "invalid_range",
      "range_empty",
      "clickhouse_unreachable",
    ]);
  });

  it("unknown_projection: name is not in the closed registry", async () => {
    const result = await planClickhouseRebuild(
      { projection: "definitely_not_a_real_projection" },
      { now: NOW, readPartitions: stubAdapter({ partitions: [] }) },
    );
    expectRejected(result, "unknown_projection");
    if (result.kind === "rejected") {
      expect(result.message).toContain("definitely_not_a_real_projection");
    }
  });

  it("unknown_projection: empty string is rejected", async () => {
    const result = await planClickhouseRebuild(
      { projection: "" },
      { now: NOW, readPartitions: stubAdapter({ partitions: [] }) },
    );
    expectRejected(result, "unknown_projection");
  });

  it("unknown_projection: takes priority over a missing adapter", async () => {
    // No adapter wired. Validate that the projection rejection still
    // fires first; clickhouse_unreachable should only show up when
    // the name resolves.
    const result = await planClickhouseRebuild({ projection: "still_bogus" }, { now: NOW });
    expectRejected(result, "unknown_projection");
  });

  it("invalid_range: --to precedes --from", async () => {
    const result = await planClickhouseRebuild(
      {
        projection: "event_daily_counts",
        fromTs: "2026-05-10T00:00:00Z",
        toTs: "2026-05-01T00:00:00Z",
      },
      { now: NOW, readPartitions: stubAdapter({ partitions: [] }) },
    );
    expectRejected(result, "invalid_range");
  });

  it("invalid_range: only one bound supplied", async () => {
    const result = await planClickhouseRebuild(
      { projection: "event_daily_counts", fromTs: "2026-05-10T00:00:00Z" },
      { now: NOW, readPartitions: stubAdapter({ partitions: [] }) },
    );
    expectRejected(result, "invalid_range");
  });

  it("invalid_range: malformed ISO string", async () => {
    const result = await planClickhouseRebuild(
      {
        projection: "event_daily_counts",
        fromTs: "not-a-timestamp",
        toTs: "2026-05-10T00:00:00Z",
      },
      { now: NOW, readPartitions: stubAdapter({ partitions: [] }) },
    );
    expectRejected(result, "invalid_range");
  });

  it("invalid_range: NaN Date", async () => {
    const badDate = new Date("not-a-date");
    const result = await planClickhouseRebuild(
      {
        projection: "event_daily_counts",
        fromTs: badDate,
        toTs: new Date("2026-05-10T00:00:00Z"),
      },
      { now: NOW, readPartitions: stubAdapter({ partitions: [] }) },
    );
    expectRejected(result, "invalid_range");
  });

  it("range_empty: --from === --to", async () => {
    const result = await planClickhouseRebuild(
      {
        projection: "event_daily_counts",
        fromTs: "2026-05-10T00:00:00Z",
        toTs: "2026-05-10T00:00:00Z",
      },
      { now: NOW, readPartitions: stubAdapter({ partitions: [] }) },
    );
    expectRejected(result, "range_empty");
  });

  it("clickhouse_unreachable: no adapter supplied", async () => {
    const result = await planClickhouseRebuild({ projection: "event_daily_counts" }, { now: NOW });
    expectRejected(result, "clickhouse_unreachable");
  });

  it("clickhouse_unreachable: adapter throws", async () => {
    const result = await planClickhouseRebuild(
      { projection: "event_daily_counts" },
      { now: NOW, readPartitions: stubAdapter(new Error("connection refused")) },
    );
    expectRejected(result, "clickhouse_unreachable");
    if (result.kind === "rejected") {
      expect(result.message).toContain("connection refused");
    }
  });
});

describe("planClickhouseRebuild — happy path", () => {
  it("full-table rebuild: returns a planned response with partition list", async () => {
    const calls: AdapterCall[] = [];
    const result = await planClickhouseRebuild(
      { projection: "event_daily_counts" },
      {
        now: NOW,
        readPartitions: stubAdapter(
          {
            partitions: [
              { partition: "202604", rowsEstimated: 10_000 },
              { partition: "202605", rowsEstimated: 25_000 },
            ],
          },
          calls,
        ),
      },
    );
    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") return;
    expect(result.projection).toBe("event_daily_counts");
    expect(result.targetTableQualified).toBe("polaris.event_daily_counts");
    expect(result.sourceRangeFrom).toBeNull();
    expect(result.sourceRangeTo).toBeNull();
    expect(result.partitions).toEqual([
      { partition: "202604", rowsEstimated: 10_000 },
      { partition: "202605", rowsEstimated: 25_000 },
    ]);
    expect(result.partitionCount).toBe(2);
    expect(result.rowsTotalEstimated).toBe(35_000);
    expect(result.knownGaps).toEqual([]);
    expect(result.plannedAt).toBe("2026-05-15T12:00:00.000Z");
    expect(result.plannerVersion).toBe("v1");
    expect(result.descriptor.name).toBe("event_daily_counts");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.qualifiedTable).toBe("polaris.event_daily_counts");
    expect(calls[0]?.fromTs).toBeNull();
    expect(calls[0]?.toTs).toBeNull();
  });

  it("bounded range: passes from/to to the adapter as Date objects", async () => {
    const calls: AdapterCall[] = [];
    const result = await planClickhouseRebuild(
      {
        projection: "event_daily_counts",
        fromTs: "2026-05-01T00:00:00Z",
        toTs: "2026-05-05T00:00:00Z",
      },
      {
        now: NOW,
        readPartitions: stubAdapter(
          { partitions: [{ partition: "202605", rowsEstimated: 5_000 }] },
          calls,
        ),
      },
    );
    if (result.kind !== "planned") {
      throw new Error(`expected planned, got ${result.kind}`);
    }
    expect(result.sourceRangeFrom).toBe("2026-05-01T00:00:00.000Z");
    expect(result.sourceRangeTo).toBe("2026-05-05T00:00:00.000Z");
    expect(calls[0]?.fromTs?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(calls[0]?.toTs?.toISOString()).toBe("2026-05-05T00:00:00.000Z");
  });

  it("forwards adapter knownGaps onto the plan and dedupes", async () => {
    const result = await planClickhouseRebuild(
      { projection: "event_daily_counts" },
      {
        now: NOW,
        readPartitions: stubAdapter({
          partitions: [{ partition: "202605", rowsEstimated: 1 }],
          knownGaps: [
            "skipped inactive parts in 202604",
            "system.parts row count includes pre-merge duplicates",
            "skipped inactive parts in 202604", // duplicate
          ],
        }),
      },
    );
    if (result.kind !== "planned") {
      throw new Error(`expected planned, got ${result.kind}`);
    }
    expect(result.knownGaps).toEqual([
      "skipped inactive parts in 202604",
      "system.parts row count includes pre-merge duplicates",
    ]);
  });

  it("clamps a negative rowsEstimated contribution to zero in the total", async () => {
    // Defensive: a future adapter that reports -1 for "unknown" must
    // not produce a negative rowsTotalEstimated.
    const result = await planClickhouseRebuild(
      { projection: "event_daily_counts" },
      {
        now: NOW,
        readPartitions: stubAdapter({
          partitions: [
            { partition: "202604", rowsEstimated: -1 },
            { partition: "202605", rowsEstimated: 1_000 },
          ],
        }),
      },
    );
    if (result.kind !== "planned") {
      throw new Error(`expected planned, got ${result.kind}`);
    }
    expect(result.rowsTotalEstimated).toBe(1_000);
  });

  it("registry: at least one rebuildable projection is exported", () => {
    expect(REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES.length).toBeGreaterThanOrEqual(1);
    expect(REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES).toContain("event_daily_counts");
  });

  it("descriptor: every registered projection has the expected fields shape", async () => {
    for (const name of REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES) {
      const result = await planClickhouseRebuild(
        { projection: name },
        { now: NOW, readPartitions: stubAdapter({ partitions: [] }) },
      );
      if (result.kind !== "planned") {
        throw new Error(`expected planned for ${name}, got ${result.kind}`);
      }
      expect(result.descriptor.qualifiedTable).toMatch(/^polaris\.[a-z][a-z0-9_]*$/);
      expect(result.descriptor.sqlFile).toMatch(/^sql\/clickhouse\/projections\/.+\.sql$/);
      expect(result.descriptor.feederMvFile).toMatch(
        /^sql\/clickhouse\/materialized-views\/.+\.sql$/,
      );
      expect(result.descriptor.description.length).toBeGreaterThan(0);
    }
  });

  it("does NOT retain a reference to the input declaration", async () => {
    const declaration = {
      projection: "event_daily_counts",
      fromTs: "2026-05-01T00:00:00Z",
      toTs: "2026-05-05T00:00:00Z",
    };
    const result = await planClickhouseRebuild(declaration, {
      now: NOW,
      readPartitions: stubAdapter({
        partitions: [{ partition: "202605", rowsEstimated: 100 }],
      }),
    });
    if (result.kind !== "planned") {
      throw new Error("expected planned");
    }
    const before = JSON.stringify(result);
    // Mutate the declaration after planning. The cloned plan must
    // not change.
    (declaration as { projection: string }).projection = "mutated";
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe("planClickhouseRebuild — determinism", () => {
  it("same input + same clock + same adapter -> same plan", async () => {
    const adapter = stubAdapter({
      partitions: [
        { partition: "202604", rowsEstimated: 10 },
        { partition: "202605", rowsEstimated: 20 },
      ],
    });
    const a = await planClickhouseRebuild(
      { projection: "event_daily_counts" },
      { now: NOW, readPartitions: adapter },
    );
    const b = await planClickhouseRebuild(
      { projection: "event_daily_counts" },
      { now: NOW, readPartitions: adapter },
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

function expectRejected(
  result: ClickhouseRebuildPlan,
  expectedCode: (typeof CLICKHOUSE_REBUILD_REJECTION_CODES)[number],
): void {
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") return;
  expect(result.code).toBe(expectedCode);
  expect(result.message.length).toBeGreaterThan(0);
}
