/**
 * Operator-profile ClickHouse driver for the rebuild executor.
 *
 * Wraps the {@link OperatorRaw} escape hatch with two thin methods
 * that match the {@link ClickhouseRebuildDriver} contract:
 *
 *   - `clearSlice` — for a full-table rebuild, issues
 *     `TRUNCATE TABLE <projection>`. For a ranged rebuild, issues
 *     `ALTER TABLE <projection> DROP PARTITION <p>` once per
 *     partition the planner returned. Both primitives are
 *     synchronous in ClickHouse, so no mutation polling is needed.
 *
 *   - `rebuildPartition` — issues
 *     `INSERT INTO <projection> <select>` where `<select>` is the
 *     SELECT body checked in under `descriptor.rebuildSelectFile`,
 *     bound to the partition via the `{partition:String}` parameter.
 *
 * Why a separate rebuild SELECT file (and not parsing the live MV
 * SQL): the MV statement is a `CREATE MATERIALIZED VIEW … AS SELECT`
 * wrapper; parsing the SELECT out of it is fragile. The rebuild
 * SELECT lives in its own file next to the projection DDL and the
 * projection-registry test asserts both exist.
 *
 * @see packages/shared-clickhouse/src/rebuild/executor.ts
 * @see sql/clickhouse/projections/40_event_daily_counts_rebuild.sql
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OperatorRaw } from "../raw.js";
import type { ClickhouseRebuildDriver } from "./executor.js";
import {
  type ClickhouseProjectionDescriptor,
  REBUILDABLE_CLICKHOUSE_PROJECTIONS,
} from "./projections.js";

/** Caller label stamped onto every raw.query call this driver makes. */
export const REBUILD_DRIVER_CALLER = "polaris-cli/clickhouse-rebuild" as const;

export interface CreateClickhouseRebuildDriverInput {
  /** Operator escape hatch this driver routes every SQL call through. */
  readonly raw: OperatorRaw;
  /**
   * Job id of the rebuild row. Stamped into every raw.query `reason`
   * so the escape-hatch audit log carries it.
   */
  readonly jobId: string;
  /**
   * Closed set of projections this driver can rebuild. Defaults to
   * {@link REBUILDABLE_CLICKHOUSE_PROJECTIONS}. Injected for tests so
   * a fixture descriptor can point `rebuildSelectFile` at a temp
   * path.
   */
  readonly projections?: ReadonlyArray<ClickhouseProjectionDescriptor>;
  /**
   * Repo root that `rebuildSelectFile` paths resolve against.
   * Defaults to the directory the CLI is invoked from. Injected
   * for tests.
   */
  readonly repoRoot?: string;
  /**
   * Filesystem reader for the SELECT body. Defaults to
   * `readFileSync`. Injected for tests.
   */
  readonly readFile?: (absolutePath: string) => string;
}

/**
 * Construct a `ClickhouseRebuildDriver` backed by `raw.query`. Reads
 * each projection's rebuild SELECT eagerly at construction so a
 * missing/unreadable SELECT file fails the CLI startup rather than
 * the middle of an in-flight rebuild.
 */
export function createClickhouseRebuildDriver(
  input: CreateClickhouseRebuildDriverInput,
): ClickhouseRebuildDriver {
  const projections = input.projections ?? REBUILDABLE_CLICKHOUSE_PROJECTIONS;
  const repoRoot = input.repoRoot ?? process.cwd();
  const readFile = input.readFile ?? ((p: string): string => readFileSync(p, "utf8"));

  // Eagerly load every projection's rebuild SELECT. Failing here
  // surfaces as `clickhouse_rebuild_driver_select_unreadable` at
  // driver construction; if we deferred the read to
  // `rebuildPartition`, an operator running the command would see
  // the row resolve into `failed` mid-flight instead of refusing to
  // start, which masks the configuration problem.
  const selectByFile = new Map<string, string>();
  for (const projection of projections) {
    const absolute = resolve(repoRoot, projection.rebuildSelectFile);
    let body: string;
    try {
      body = readFile(absolute);
    } catch (cause) {
      throw new Error(
        `clickhouse_rebuild_driver_select_unreadable: cannot read ${projection.rebuildSelectFile} (resolved to ${absolute}) for projection ${projection.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw new Error(
        `clickhouse_rebuild_driver_select_empty: ${projection.rebuildSelectFile} for projection ${projection.name} is empty after trim`,
      );
    }
    // Strip a single trailing semicolon: the SELECT is wrapped in
    // `INSERT INTO … <select>` and ClickHouse rejects the embedded
    // semicolon. The check-in convention is "one terminating
    // semicolon" so this is safe.
    const stripped = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
    selectByFile.set(projection.rebuildSelectFile, stripped);
  }

  return {
    async clearSlice(slice): Promise<void> {
      const fullTable = slice.sourceRangeFrom === null && slice.sourceRangeTo === null;
      if (fullTable) {
        await input.raw.query(
          `TRUNCATE TABLE ${slice.qualifiedTable}`,
          {},
          {
            caller: REBUILD_DRIVER_CALLER,
            reason: `rebuild ${slice.qualifiedTable} ${input.jobId} clearSlice full`,
          },
        );
        return;
      }
      for (const partition of slice.partitions) {
        await input.raw.query(
          `ALTER TABLE ${slice.qualifiedTable} DROP PARTITION {partition:String}`,
          { partition },
          {
            caller: REBUILD_DRIVER_CALLER,
            reason: `rebuild ${slice.qualifiedTable} ${input.jobId} clearSlice partition=${partition}`,
          },
        );
      }
    },

    async rebuildPartition(p): Promise<{ readonly rows_inserted: number }> {
      const selectBody = selectByFile.get(p.rebuildSelectFile);
      if (selectBody === undefined) {
        // Defensive: the executor's pre-flight already rejects
        // unknown projections via `findRebuildableProjection`, so
        // this only fires if a caller hands the driver an
        // out-of-registry descriptor.
        throw new Error(
          `clickhouse_rebuild_driver_unknown_select: no rebuild SELECT loaded for ${p.rebuildSelectFile}`,
        );
      }
      const sql = `INSERT INTO ${p.qualifiedTable}
${selectBody}`;
      const result = await input.raw.query(
        sql,
        { partition: p.partition },
        {
          caller: REBUILD_DRIVER_CALLER,
          reason: `rebuild ${p.qualifiedTable} ${input.jobId} partition=${p.partition}`,
        },
      );
      // ClickHouse INSERTs don't return rows in the result body, so
      // `result.rowCount` is 0. Surface that honestly; if we ever
      // need real inserted-row counts we can issue a follow-up
      // `system.query_log` lookup in the same audited transaction.
      return { rows_inserted: result.rowCount };
    },
  };
}
