/**
 * Behavioural tests for `createClickhouseRebuildDriver` (BL565N7Y +
 * ENCXI9BE).
 *
 * Drives the operator-profile `raw.query` escape hatch from the
 * outside — assertions are on the SQL strings + audit context the
 * driver issues, not on the response shape. Coverage:
 *
 *   - full rebuild → TRUNCATE TABLE,
 *   - ranged rebuild → ALTER TABLE … DROP PARTITION per partition,
 *   - rebuildPartition → INSERT INTO … <select> with the partition
 *     parameter bound (no string interpolation), followed by a
 *     SYSTEM FLUSH LOGS + system.query_log lookup (ENCXI9BE),
 *   - caller/reason propagated on every raw.query call,
 *   - missing rebuildSelectFile fails at construction, not at
 *     rebuildPartition (fail-fast contract on AC 5).
 *
 * Tests inject `sleep` so the backoff schedule is exercised without
 * real wall-clock waits.
 *
 * @see libs/persistence/clickhouse/src/rebuild/driver.ts
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { OperatorRaw, RawQueryResult } from "../src/index.js";
import {
  buildRebuildQueryId,
  type ClickhouseProjectionDescriptor,
  createClickhouseRebuildDriver,
  REBUILD_DRIVER_CALLER,
} from "../src/rebuild/index.js";

/** Monorepo root: this file lives at `libs/persistence/clickhouse/test/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

interface RecordedCall {
  readonly sql: string;
  readonly parameters: Record<string, unknown>;
  readonly caller: string;
  readonly reason: string;
  readonly queryId?: string;
}

interface FakeRaw {
  readonly raw: OperatorRaw;
  readonly calls: RecordedCall[];
}

/**
 * Build a synthetic OperatorRaw that records every call and lets
 * the test script per-call responses. The script is matched against
 * each query's SQL prefix; on miss, default behaviour is to return
 * `{ rows: [], rowCount: 0 }` (the silent best-effort path).
 */
function makeRaw(
  script: Array<{
    readonly match: (sql: string) => boolean;
    // biome-ignore lint/suspicious/noExplicitAny: synthetic response
    readonly response: RawQueryResult<any>;
  }> = [],
): FakeRaw {
  const calls: RecordedCall[] = [];
  return {
    raw: {
      // biome-ignore lint/suspicious/noExplicitAny: synthetic stub
      async query(sql, parameters, context): Promise<any> {
        calls.push({
          sql,
          parameters: { ...parameters },
          caller: context.caller,
          reason: context.reason,
          ...(context.queryId !== undefined ? { queryId: context.queryId } : {}),
        });
        const hit = script.find((s) => s.match(sql));
        return hit?.response ?? { rows: [], rowCount: 0, query: sql };
      },
    },
    calls,
  };
}

const FIXTURE_SELECT = `SELECT project_id FROM polaris.analytics_raw WHERE _partition_id = {partition:String}`;

const FIXTURE_PROJECTION: ClickhouseProjectionDescriptor = {
  name: "event_daily_counts",
  qualifiedTable: "polaris.event_daily_counts",
  sqlFile: "db/clickhouse/projections/40_event_daily_counts.sql",
  feederMvFile: "db/clickhouse/materialized-views/41_mv_raw_to_event_daily_counts.sql",
  rebuildSelectFile: "db/clickhouse/projections/40_event_daily_counts_rebuild.sql",
  description: "fixture",
};

function buildDriver(opts: {
  readonly raw: OperatorRaw;
  readonly jobId?: string;
  readonly select?: string;
  readonly sleepDelays?: number[];
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
    sleep: async (ms: number) => {
      opts.sleepDelays?.push(ms);
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
    const { raw, calls } = makeRaw([
      {
        match: (sql) => sql.startsWith("SELECT written_rows"),
        response: { rows: [{ written_rows: 12_345 }], rowCount: 1, query: "" },
      },
    ]);
    const driver = buildDriver({ raw });
    const result = await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    // 3 calls: INSERT, SYSTEM FLUSH LOGS, SELECT written_rows.
    expect(calls).toHaveLength(3);
    const insert = calls[0];
    expect(insert?.sql.startsWith("INSERT INTO polaris.event_daily_counts\n")).toBe(true);
    expect(insert?.sql).toContain(FIXTURE_SELECT);
    expect(insert?.parameters).toEqual({ partition: "202604" });
    expect(insert?.reason).toContain("partition=202604");
    expect(insert?.caller).toBe(REBUILD_DRIVER_CALLER);
    expect(insert?.queryId).toBe(buildRebuildQueryId("polaris_chr_test1", "202604"));
    // rows_inserted is recovered from system.query_log.
    expect(result.rows_inserted).toBe(12_345);
  });

  it("rebuildPartition: issues SYSTEM FLUSH LOGS before reading written_rows", async () => {
    const { raw, calls } = makeRaw([
      {
        match: (sql) => sql.startsWith("SELECT written_rows"),
        response: { rows: [{ written_rows: 100 }], rowCount: 1, query: "" },
      },
    ]);
    const driver = buildDriver({ raw });
    await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    // Order: INSERT, FLUSH LOGS, SELECT.
    expect(calls[0]?.sql.startsWith("INSERT INTO")).toBe(true);
    expect(calls[1]?.sql).toBe("SYSTEM FLUSH LOGS");
    expect(calls[1]?.caller).toBe(REBUILD_DRIVER_CALLER);
    expect(calls[1]?.reason).toContain("flush_query_log");
    expect(calls[2]?.sql.startsWith("SELECT written_rows")).toBe(true);
    expect(calls[2]?.sql).toContain("FROM system.query_log");
    expect(calls[2]?.sql).toContain("type = 'QueryFinish'");
    expect(calls[2]?.parameters).toEqual({
      qid: buildRebuildQueryId("polaris_chr_test1", "202604"),
    });
  });

  it("rebuildPartition: query_log row is string-encoded UInt64 → coerced to number", async () => {
    const { raw } = makeRaw([
      {
        match: (sql) => sql.startsWith("SELECT written_rows"),
        // ClickHouse's HTTP JSON encodes UInt64 as a string.
        response: { rows: [{ written_rows: "999999999999" }], rowCount: 1, query: "" },
      },
    ]);
    const driver = buildDriver({ raw });
    const result = await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    expect(result.rows_inserted).toBe(999_999_999_999);
    expect(typeof result.rows_inserted).toBe("number");
  });

  it("rebuildPartition: empty query_log → retries with backoff then resolves to 0", async () => {
    const { raw, calls } = makeRaw(); // every SELECT returns empty rows
    const sleepDelays: number[] = [];
    const driver = buildDriver({ raw, sleepDelays });
    const result = await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    // 5 calls total: INSERT, FLUSH LOGS, SELECT × 3 (the backoff
    // schedule).
    expect(calls).toHaveLength(5);
    const selectCalls = calls.filter((c) => c.sql.startsWith("SELECT written_rows"));
    expect(selectCalls).toHaveLength(3);
    // Backoff: attempts 2 and 3 each sleep first. Attempt 1 is
    // immediate (0ms — recorded but no-op in tests).
    expect(sleepDelays.filter((ms) => ms > 0)).toEqual([300, 700]);
    // Result: 0 because no log entry was readable.
    expect(result.rows_inserted).toBe(0);
  });

  it("rebuildPartition: query_log row appears on attempt 2 → returns that count without further retries", async () => {
    let attempt = 0;
    const calls: RecordedCall[] = [];
    const raw: OperatorRaw = {
      async query(sql, parameters, context) {
        calls.push({
          sql,
          parameters: { ...parameters },
          caller: context.caller,
          reason: context.reason,
          ...(context.queryId !== undefined ? { queryId: context.queryId } : {}),
        });
        if (sql.startsWith("SELECT written_rows")) {
          attempt += 1;
          if (attempt === 1) return { rows: [], rowCount: 0, query: sql };
          return { rows: [{ written_rows: 4_567 }], rowCount: 1, query: sql };
        }
        return { rows: [], rowCount: 0, query: sql };
      },
    };
    const sleepDelays: number[] = [];
    const driver = buildDriver({ raw, sleepDelays });
    const result = await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    expect(result.rows_inserted).toBe(4_567);
    // 4 calls: INSERT, FLUSH LOGS, SELECT (empty), SELECT (hit).
    expect(calls).toHaveLength(4);
    // One 300ms sleep before the second SELECT, no 700ms sleep
    // because the second attempt resolved.
    expect(sleepDelays.filter((ms) => ms > 0)).toEqual([300]);
  });

  it("rebuildPartition: query_log SELECT throws → fall through to next backoff attempt", async () => {
    let attempt = 0;
    const calls: RecordedCall[] = [];
    const raw: OperatorRaw = {
      async query(sql, parameters, context) {
        calls.push({
          sql,
          parameters: { ...parameters },
          caller: context.caller,
          reason: context.reason,
          ...(context.queryId !== undefined ? { queryId: context.queryId } : {}),
        });
        if (sql.startsWith("SELECT written_rows")) {
          attempt += 1;
          if (attempt === 1) throw new Error("transient network blip");
          return { rows: [{ written_rows: 50 }], rowCount: 1, query: sql };
        }
        return { rows: [], rowCount: 0, query: sql };
      },
    };
    const sleepDelays: number[] = [];
    const driver = buildDriver({ raw, sleepDelays });
    const result = await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    // Catch-then-retry path: the first SELECT threw, the second
    // succeeded. Result reflects the second.
    expect(result.rows_inserted).toBe(50);
  });

  it("rebuildPartition: SYSTEM FLUSH LOGS throws → still proceeds to the SELECT loop", async () => {
    const calls: RecordedCall[] = [];
    const raw: OperatorRaw = {
      async query(sql, parameters, context) {
        calls.push({
          sql,
          parameters: { ...parameters },
          caller: context.caller,
          reason: context.reason,
          ...(context.queryId !== undefined ? { queryId: context.queryId } : {}),
        });
        if (sql === "SYSTEM FLUSH LOGS") {
          throw new Error("flush rejected (operator lacks SYSTEM:FLUSH LOGS grant)");
        }
        if (sql.startsWith("SELECT written_rows")) {
          return { rows: [{ written_rows: 7 }], rowCount: 1, query: sql };
        }
        return { rows: [], rowCount: 0, query: sql };
      },
    };
    const driver = buildDriver({ raw });
    const result = await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: FIXTURE_PROJECTION.feederMvFile,
      rebuildSelectFile: FIXTURE_PROJECTION.rebuildSelectFile,
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    expect(result.rows_inserted).toBe(7);
    // FLUSH LOGS was attempted (and threw); the SELECT still ran.
    const flushCall = calls.find((c) => c.sql === "SYSTEM FLUSH LOGS");
    expect(flushCall).toBeDefined();
    const selectCall = calls.find((c) => c.sql.startsWith("SELECT written_rows"));
    expect(selectCall).toBeDefined();
  });

  it("rebuildPartition: strips a single trailing semicolon from the SELECT before wrapping in INSERT", async () => {
    const { raw, calls } = makeRaw([
      {
        match: (sql) => sql.startsWith("SELECT written_rows"),
        response: { rows: [{ written_rows: 1 }], rowCount: 1, query: "" },
      },
    ]);
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
    const insert = calls[0];
    // INSERT SQL never ends with ';' (would break ClickHouse's
    // INSERT … <select> parser).
    expect(insert?.sql.endsWith(";")).toBe(false);
    expect(insert?.sql).toContain(FIXTURE_SELECT);
  });

  it("rebuildPartition: refuses an unknown rebuildSelectFile (defensive)", async () => {
    const { raw } = makeRaw();
    const driver = buildDriver({ raw });
    await expect(
      driver.rebuildPartition({
        qualifiedTable: "polaris.event_daily_counts",
        feederMvFile: FIXTURE_PROJECTION.feederMvFile,
        rebuildSelectFile: "db/clickhouse/projections/40_unknown_rebuild.sql",
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
    // production path against the real files on disk. `repoRoot` is
    // derived from this file's own location rather than left to
    // default to `process.cwd()`, so the case holds whether the run
    // starts from the monorepo root or from this package directory.
    const { raw, calls } = makeRaw([
      {
        match: (sql) => sql.startsWith("SELECT written_rows"),
        response: { rows: [{ written_rows: 1 }], rowCount: 1, query: "" },
      },
    ]);
    const driver = createClickhouseRebuildDriver({
      raw,
      jobId: "polaris_chr_test1",
      repoRoot: REPO_ROOT,
      sleep: async () => undefined,
    });
    await driver.rebuildPartition({
      qualifiedTable: "polaris.event_daily_counts",
      feederMvFile: "db/clickhouse/materialized-views/41_mv_raw_to_event_daily_counts.sql",
      rebuildSelectFile: "db/clickhouse/projections/40_event_daily_counts_rebuild.sql",
      partition: "202604",
      sourceRangeFrom: null,
      sourceRangeTo: null,
    });
    // The checked-in SELECT mentions the canonical MV pattern.
    const insert = calls[0];
    expect(insert?.sql).toContain("FROM polaris.analytics_raw");
    expect(insert?.sql).toContain("argMax(occurred_at, _version)");
    expect(insert?.sql).toContain("{partition:String}");
    expect(insert?.parameters).toEqual({ partition: "202604" });
  });
});

describe("buildRebuildQueryId", () => {
  it("returns a stable {jobId}_p{partition} pair", () => {
    expect(buildRebuildQueryId("polaris_chr_test1", "202604")).toBe("polaris_chr_test1_p202604");
  });

  it("is deterministic across calls", () => {
    const a = buildRebuildQueryId("j", "1");
    const b = buildRebuildQueryId("j", "1");
    expect(a).toBe(b);
  });
});
