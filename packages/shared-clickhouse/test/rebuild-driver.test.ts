/**
 * Behavioural tests for `createClickhouseRebuildDriver` (BL565N7Y).
 *
 * Drives the operator-profile `raw.query` escape hatch from the
 * outside — assertions are on the SQL strings + audit context the
 * driver issues, not on the response shape. Coverage:
 *
 *   - full rebuild → TRUNCATE TABLE,
 *   - ranged rebuild → ALTER TABLE … DROP PARTITION per partition,
 *   - rebuildPartition → INSERT INTO … <select> with the partition
 *     parameter bound (no string interpolation),
 *   - caller/reason propagated on every raw.query call,
 *   - missing rebuildSelectFile fails at construction, not at
 *     rebuildPartition (fail-fast contract on AC 5).
 *
 * @see packages/shared-clickhouse/src/rebuild/driver.ts
 */

import { describe, expect, it } from "vitest";

import type { OperatorRaw } from "../src/raw.js";
import {
  type ClickhouseProjectionDescriptor,
  createClickhouseRebuildDriver,
  REBUILD_DRIVER_CALLER,
} from "../src/rebuild/index.js";

interface RecordedCall {
  readonly sql: string;
  readonly parameters: Record<string, unknown>;
  readonly caller: string;
  readonly reason: string;
}

function makeRaw(): { readonly raw: OperatorRaw; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    raw: {
      async query(sql, parameters, context) {
        calls.push({
          sql,
          parameters: { ...parameters },
          caller: context.caller,
          reason: context.reason,
        });
        return { rows: [], rowCount: 0, query: sql };
      },
    },
    calls,
  };
}

const FIXTURE_SELECT = `SELECT project_id FROM polaris.analytics_raw WHERE _partition_id = {partition:String}`;

const FIXTURE_PROJECTION: ClickhouseProjectionDescriptor = {
  name: "event_daily_counts",
  qualifiedTable: "polaris.event_daily_counts",
  sqlFile: "sql/clickhouse/projections/40_event_daily_counts.sql",
  feederMvFile: "sql/clickhouse/materialized-views/41_mv_raw_to_event_daily_counts.sql",
  rebuildSelectFile: "sql/clickhouse/projections/40_event_daily_counts_rebuild.sql",
  description: "fixture",
};

function buildDriver(opts: {
  readonly raw: OperatorRaw;
  readonly jobId?: string;
  readonly select?: string;
}) {
  return createClickhouseRebuildDriver({
    raw: opts.raw,
    jobId: opts.jobId ?? "polaris_chr_test1",
    projections: [FIXTURE_PROJECTION],
    repoRoot: "/repo",
    readFile: (absolute) => {
      if (absolute === `/repo/${FIXTURE_PROJECTION.rebuildSelectFile}`) {
        return opts.select ?? FIXTURE_SELECT;
      }
      throw new Error(`unexpected readFile path: ${absolute}`);
    },
  });
}

describe("createClickhouseRebuildDriver", () => {
  it("clearSlice (full rebuild): issues TRUNCATE TABLE with operator audit context", async () => {
    const { raw, calls } = makeRaw();
    const driver = buildDriver({ raw });
    await driver.clearSlice({
      qualifiedTable: "polaris.event_daily_counts",
      sourceRangeFrom: null,
      sourceRangeTo: null,
      partitions: ["202604", "202605"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe("TRUNCATE TABLE polaris.event_daily_counts");
    expect(calls[0]?.parameters).toEqual({});
    expect(calls[0]?.caller).toBe(REBUILD_DRIVER_CALLER);
    expect(calls[0]?.reason).toContain("clearSlice full");
    expect(calls[0]?.reason).toContain("polaris_chr_test1");
  });

  it("clearSlice (ranged rebuild): issues one DROP PARTITION per partition with bound parameter", async () => {
    const { raw, calls } = makeRaw();
    const driver = buildDriver({ raw });
    await driver.clearSlice({
      qualifiedTable: "polaris.event_daily_counts",
      sourceRangeFrom: "2026-04-01T00:00:00.000Z",
      sourceRangeTo: "2026-05-31T23:59:59.999Z",
      partitions: ["202604", "202605"],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toBe(
      "ALTER TABLE polaris.event_daily_counts DROP PARTITION {partition:String}",
    );
    expect(calls[0]?.parameters).toEqual({ partition: "202604" });
    expect(calls[0]?.reason).toContain("partition=202604");
    expect(calls[1]?.parameters).toEqual({ partition: "202605" });
    expect(calls[1]?.reason).toContain("partition=202605");
    // Partition label MUST be bound as a parameter, not interpolated
    // into the SQL — the literal `{partition:String}` placeholder
    // stays in the SQL string.
    expect(calls[0]?.sql).toContain("{partition:String}");
    expect(calls[1]?.sql).toContain("{partition:String}");
  });

  it("clearSlice (ranged, partial range with one partition): still drops only the listed partition(s)", async () => {
    const { raw, calls } = makeRaw();
    const driver = buildDriver({ raw });
    await driver.clearSlice({
      qualifiedTable: "polaris.event_daily_counts",
      sourceRangeFrom: "2026-04-01T00:00:00.000Z",
      sourceRangeTo: "2026-04-30T23:59:59.999Z",
      partitions: ["202604"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parameters).toEqual({ partition: "202604" });
  });

  it("rebuildPartition: wraps the checked-in SELECT in INSERT INTO and binds {partition:String}", async () => {
    const { raw, calls } = makeRaw();
    const driver = buildDriver({ raw });
    const result = await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql.startsWith("INSERT INTO polaris.event_daily_counts\n")).toBe(true);
    expect(calls[0]?.sql).toContain(FIXTURE_SELECT);
    expect(calls[0]?.parameters).toEqual({ partition: "202604" });
    expect(calls[0]?.reason).toContain("partition=202604");
    expect(calls[0]?.caller).toBe(REBUILD_DRIVER_CALLER);
    // INSERTs don't return rows in the result body; rows_inserted
    // reflects raw.query's rowCount, which is 0 here.
    expect(result.rows_inserted).toBe(0);
  });

  it("rebuildPartition: strips a single trailing semicolon from the SELECT before wrapping in INSERT", async () => {
    const { raw, calls } = makeRaw();
    const driver = buildDriver({
      raw,
      select: `${FIXTURE_SELECT};`,
    });
    await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    expect(calls[0]?.sql.endsWith(";")).toBe(false);
    expect(calls[0]?.sql).toContain(FIXTURE_SELECT);
  });

  it("rebuildPartition: refuses an unknown rebuildSelectFile (defensive)", async () => {
    const { raw } = makeRaw();
    const driver = buildDriver({ raw });
    await expect(
      driver.rebuildPartition({
        qualifiedTable: "polaris.event_daily_counts",
        feederMvFile: FIXTURE_PROJECTION.feederMvFile,
        rebuildSelectFile: "sql/clickhouse/projections/40_unknown_rebuild.sql",
        partition: "202604",
        sourceRangeFrom: null,
        sourceRangeTo: null,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("clickhouse_rebuild_driver_unknown_select"),
    });
  });

  it("construction: missing rebuildSelectFile fails at construction (fail-fast contract)", async () => {
    const { raw } = makeRaw();
    expect(() =>
      createClickhouseRebuildDriver({
        raw,
        jobId: "polaris_chr_test1",
        projections: [FIXTURE_PROJECTION],
        repoRoot: "/repo",
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(/clickhouse_rebuild_driver_select_unreadable/);
  });

  it("construction: empty rebuildSelectFile fails at construction", async () => {
    const { raw } = makeRaw();
    expect(() =>
      createClickhouseRebuildDriver({
        raw,
        jobId: "polaris_chr_test1",
        projections: [FIXTURE_PROJECTION],
        repoRoot: "/repo",
        readFile: () => "   \n  ",
      }),
    ).toThrow(/clickhouse_rebuild_driver_select_empty/);
  });

  it("default registry: the checked-in event_daily_counts rebuild SELECT is loadable from disk", async () => {
    // No injected `projections` / `readFile` — exercises the
    // production path against the real `process.cwd()` from the
    // monorepo root. The test suite always runs from there.
    const { raw, calls } = makeRaw();
    const driver = createClickhouseRebuildDriver({
      raw,
      jobId: "polaris_chr_test1",
    });
    await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: "sql/clickhouse/materialized-views/41_mv_raw_to_event_daily_counts.sql",
      rebuildSelectFile: "sql/clickhouse/projections/40_event_daily_counts_rebuild.sql",
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    expect(calls).toHaveLength(1);
    // The checked-in SELECT mentions the canonical MV pattern.
    expect(calls[0]?.sql).toContain("FROM polaris.analytics_raw");
    expect(calls[0]?.sql).toContain("argMax(occurred_at, _version)");
    expect(calls[0]?.sql).toContain("{partition:String}");
    expect(calls[0]?.parameters).toEqual({ partition: "202604" });
  });
});
