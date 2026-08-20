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
 *     The INSERT carries a deterministic `query_id`
 *     (`<jobId>_p<partition>`) so the driver can read
 *     `system.query_log.written_rows` for the actual count.
 *
 * `system.query_log` writes are asynchronous — ClickHouse flushes
 * the buffer every ~7.5s by default, with a hard flush on
 * `SYSTEM FLUSH LOGS`. The driver issues a `SYSTEM FLUSH LOGS`
 * after the INSERT, then retries the SELECT with bounded backoff.
 * Both operations are scoped under the operator caller / reason
 * audit stamp; the `system.query_log` SELECT is best-effort and a
 * failure to read the log resolves the rebuild count to `0` rather
 * than failing the partition.
 *
 * Why a separate rebuild SELECT file (and not parsing the live MV
 * SQL): the MV statement is a `CREATE MATERIALIZED VIEW … AS SELECT`
 * wrapper; parsing the SELECT out of it is fragile. The rebuild
 * SELECT lives in its own file next to the projection DDL and the
 * projection-registry test asserts both exist.
 *
 * @see libs/persistence/clickhouse/src/rebuild/executor.ts
 * @see db/clickhouse/projections/40_event_daily_counts_rebuild.sql
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

/**
 * `system.query_log` backoff schedule, in milliseconds. Three
 * attempts: an immediate read (the SYSTEM FLUSH LOGS we issue
 * right before should have written the QueryFinish entry by the
 * time we get back), then two retries with growing delays to cover
 * any flush-buffer lag on a busy server. After exhaustion the
 * driver returns `rows_inserted = 0` for the partition; the
 * rebuild itself is unaffected.
 */
const QUERY_LOG_BACKOFFS_MS = [0, 300, 700] as const;

export interface CreateClickhouseRebuildDriverInput {
  /** Operator escape hatch this driver routes every SQL call through. */
  readonly raw: OperatorRaw;
  /**
   * Job id of the rebuild row. Stamped into every raw.query `reason`
   * (and into the INSERT's `query_id` prefix) so the escape-hatch
   * audit log + system.query_log carry it.
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
  /**
   * Async sleep used between `system.query_log` retry attempts.
   * Defaults to a real `setTimeout`-backed sleep. Injected for tests
   * so the backoff schedule is exercised without real wall-clock
   * waits.
   */
  readonly sleep?: (ms: number) => Promise<void>;
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
  const sleep =
    input.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

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
      const queryId = buildRebuildQueryId(input.jobId, p.partition);
      await input.raw.query(
        sql,
        { partition: p.partition },
        {
          caller: REBUILD_DRIVER_CALLER,
          reason: `rebuild ${p.qualifiedTable} ${input.jobId} partition=${p.partition}`,
          queryId,
        },
      );
      // ClickHouse INSERTs don't return rows in their response body,
      // so the row count must come from `system.query_log`. Best
      // effort: flush logs to get the QueryFinish entry into the
      // table, then retry the SELECT with bounded backoff. On
      // exhaustion the row's `rows_inserted` is 0 — honest for "we
      // couldn't read the log", and the rebuild still resolves as
      // completed.
      const rowsInserted = await readWrittenRowsFromQueryLog({
        raw: input.raw,
        jobId: input.jobId,
        partition: p.partition,
        queryId,
        sleep,
      });
      return { rows_inserted: rowsInserted };
    },
  };
}

interface QueryLogRow {
  readonly written_rows: string | number;
}

async function readWrittenRowsFromQueryLog(input: {
  readonly raw: OperatorRaw;
  readonly jobId: string;
  readonly partition: string;
  readonly queryId: string;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<number> {
  // `SYSTEM FLUSH LOGS` is synchronous and forces the buffered
  // `system.query_log` rows to disk. Without it, the SELECT below
  // can race the default ~7.5s buffer flush. The flush takes <100ms
  // on every cluster I've measured; the cost is acceptable for the
  // per-partition lookup.
  try {
    await input.raw.query(
      "SYSTEM FLUSH LOGS",
      {},
      {
        caller: REBUILD_DRIVER_CALLER,
        reason: `rebuild ${input.jobId} partition=${input.partition} flush_query_log`,
      },
    );
  } catch {
    // Flush failures don't fail the rebuild — fall through to the
    // retry loop; if the log entry has already landed naturally the
    // SELECT still works.
  }

  const sql = [
    "SELECT written_rows",
    "FROM system.query_log",
    "WHERE query_id = {qid:String}",
    "  AND type = 'QueryFinish'",
    "ORDER BY event_time DESC",
    "LIMIT 1",
  ].join("\n");

  for (let attempt = 0; attempt < QUERY_LOG_BACKOFFS_MS.length; attempt++) {
    // biome-ignore lint/style/noNonNullAssertion: index always in range
    const delayMs = QUERY_LOG_BACKOFFS_MS[attempt]!;
    if (delayMs > 0) await input.sleep(delayMs);
    try {
      const result = await input.raw.query<QueryLogRow>(
        sql,
        { qid: input.queryId },
        {
          caller: REBUILD_DRIVER_CALLER,
          reason: `rebuild ${input.jobId} partition=${input.partition} read_written_rows attempt=${attempt + 1}`,
        },
      );
      if (result.rowCount === 1) {
        const raw = result.rows[0]?.written_rows;
        if (raw !== undefined) {
          // `written_rows` is UInt64 in ClickHouse; the HTTP JSON
          // driver returns it as a string by default. Coerce here so
          // the executor sees a real number.
          return typeof raw === "number" ? raw : Number(raw);
        }
      }
    } catch {
      // Best-effort: SELECT failures don't fail the rebuild. Keep
      // retrying within the bounded schedule, then give up to 0.
    }
  }
  return 0;
}

/**
 * Build the `query_id` for a single partition's INSERT. Stable per
 * (jobId, partition) so the follow-up `system.query_log` SELECT
 * keys on the same value. ClickHouse requires query_ids unique
 * within a window; the jobId is uuidv7-based so this is fine even
 * across concurrent rebuild jobs.
 *
 * Exported for tests that need to assert the exact id the driver
 * passes to raw.query.
 */
export function buildRebuildQueryId(jobId: string, partition: string): string {
  return `${jobId}_p${partition}`;
}
