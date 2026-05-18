/**
 * Operator-profile `system.parts` reader for the rebuild planner
 * (U342CPX9).
 *
 * The planner takes a `readPartitions` adapter (see
 * `PlanClickhouseRebuildOptions.readPartitions`) that returns one
 * row per active partition of the target projection table along
 * with its row count. This module ships the production adapter,
 * which wraps the operator escape hatch (`raw.query`) so the audit
 * log carries the same `caller` + `reason` pair every other rebuild
 * SQL call carries.
 *
 * The SELECT against `system.parts` is parameter-bound — neither
 * the database, the table, nor the range bounds are interpolated.
 * ClickHouse's `query_params` mechanism doesn't bind NULL cleanly,
 * so the no-range path uses an empty-string sentinel checked with
 * `length({from:String}) = 0` rather than threading `Nullable`
 * through.
 *
 * Range semantics: a partition is included when its data overlaps
 * the `[from, to)` window — that is, `max_time >= from` AND
 * `min_time < to`. Boundary partitions (one row outside the window)
 * may be included; that is intentional, because the rebuild SELECT
 * then re-filters on `_partition_id` inside the WHERE clause. The
 * planner sees an upper bound on what the rebuild will touch.
 *
 * @see packages/shared-clickhouse/src/rebuild/planner.ts
 * @see packages/shared-clickhouse/src/rebuild/driver.ts (sibling — for the executor side)
 */

import type { OperatorRaw } from "../raw.js";
import type { PartsSummary } from "./types.js";

/** Caller label stamped onto every raw.query call this reader makes. */
export const REBUILD_PARTS_READER_CALLER = "polaris-cli/clickhouse-rebuild-plan" as const;

export interface CreatePartsReaderInput {
  /** Operator escape hatch the reader routes every SELECT through. */
  readonly raw: OperatorRaw;
  /**
   * Database the planner is targeting (`polaris` in v1). Pinned at
   * construction because every projection in the closed set lives in
   * `polaris.*` and the table name from `qualifiedTable` is the
   * suffix we strip off.
   */
  readonly database: string;
}

interface PartsRow {
  readonly partition: string;
  readonly rows_estimated: string | number;
}

/**
 * Construct a `readPartitions` adapter the rebuild planner can
 * consume. The returned function is what `PlanClickhouseRebuildOptions`
 * declares — the planner stays free of any operator-client typing.
 */
export function createPartsReader(
  input: CreatePartsReaderInput,
): (probe: {
  readonly qualifiedTable: string;
  readonly fromTs: Date | null;
  readonly toTs: Date | null;
}) => Promise<PartsSummary> {
  const { raw, database } = input;
  return async (probe) => {
    const tableName = stripDatabasePrefix(probe.qualifiedTable, database);
    const fromIso = probe.fromTs === null ? "" : probe.fromTs.toISOString();
    const toIso = probe.toTs === null ? "" : probe.toTs.toISOString();

    const sql = [
      "SELECT partition, sum(rows) AS rows_estimated",
      "FROM system.parts",
      "WHERE database = {db:String}",
      "  AND table = {tbl:String}",
      "  AND active = 1",
      "  AND (length({from:String}) = 0 OR max_time >= parseDateTime64BestEffort({from:String}, 3))",
      "  AND (length({to:String}) = 0   OR min_time <  parseDateTime64BestEffort({to:String}, 3))",
      "GROUP BY partition",
      "ORDER BY partition",
    ].join("\n");

    const result = await raw.query<PartsRow>(
      sql,
      {
        db: database,
        tbl: tableName,
        from: fromIso,
        to: toIso,
      },
      {
        caller: REBUILD_PARTS_READER_CALLER,
        reason:
          fromIso === "" && toIso === ""
            ? `plan ${probe.qualifiedTable} full`
            : `plan ${probe.qualifiedTable} from=${fromIso} to=${toIso}`,
      },
    );

    const partitions = result.rows.map((row) => ({
      partition: row.partition,
      rowsEstimated: typeof row.rows_estimated === "number"
        ? row.rows_estimated
        : Number(row.rows_estimated),
    }));
    return { partitions };
  };
}

/**
 * Strip the `<database>.` prefix from a qualified table name. The
 * planner hands us `polaris.event_daily_counts`; `system.parts`
 * separates database and table into their own columns. If the
 * prefix doesn't match (defensive — the closed-set registry pins it
 * to `polaris.*`), we surface a structured error rather than issuing
 * a SELECT that would return zero rows.
 */
function stripDatabasePrefix(qualifiedTable: string, expectedDatabase: string): string {
  const dotIndex = qualifiedTable.indexOf(".");
  if (dotIndex === -1) {
    throw new Error(
      `clickhouse_rebuild_parts_reader_malformed_table: expected '${expectedDatabase}.<table>', got '${qualifiedTable}'`,
    );
  }
  const db = qualifiedTable.slice(0, dotIndex);
  if (db !== expectedDatabase) {
    throw new Error(
      `clickhouse_rebuild_parts_reader_database_mismatch: expected database '${expectedDatabase}', got '${db}' in '${qualifiedTable}'`,
    );
  }
  return qualifiedTable.slice(dotIndex + 1);
}
