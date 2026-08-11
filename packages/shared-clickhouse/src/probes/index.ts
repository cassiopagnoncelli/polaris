/**
 * Health probes for the canonical ClickHouse consumer.
 *
 * The v1 dashboards/alerts pattern is **proxy-via-analytics-projector**: the
 * analytics-projector processor (the only Polaris component that ingests into
 * ClickHouse through the ingestion interface table) periodically asks ClickHouse for
 * its own `system.*` health signals and re-publishes them as Polaris
 * Prometheus gauges. There is no sidecar `clickhouse_exporter` process in v1.
 *
 * The probes in this module are pure typed wrappers around the three
 * `system.*` queries the analytics-projector needs:
 *
 *   - `system.parts`              — projection-table parts pressure
 *   - `system.materialized_views` — MV-state ledger (`failed` → page alert)
 *
 * A third probe read `system.kafka_consumers` for ingestion lag. It is
 * gone: ClickHouse consumes nothing since the RabbitMQ migration, so that
 * table is permanently empty and the probe would have reported a
 * confident zero forever — the worst possible failure mode for a lag
 * signal. Ingestion lag is now `polaris_clickhouse_sink_lag_seconds`,
 * emitted by `consumers/clickhouse-sink` from the envelope's
 * `ingested_at`.
 *
 * Each helper executes a parameter-bound SQL string against the underlying
 * `@clickhouse/client` connection. They are intentionally low-level: they do
 * not own the gauges themselves (that is the processor's job) and they do not
 * emit metrics (that is also the processor's job — proxies belong in the
 * canonical consumer per `docs/architecture/07-clickhouse.md`).
 *
 * @see docs/architecture/07-clickhouse.md "Two-Layer Raw Storage" and
 *      "Query Patterns" — these probes target `system.*` views ONLY; they
 *      never query the ingestion interface table, `analytics_raw`, or
 *      projection tables directly.
 * @see docs/operations/runbook-clickhouse-ingestion-lag.md — the operator
 *      runbook that maps each probe row to a triage step.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { runQuery } from "../internal/exec.js";
import { assertIdentifier, assertNoFinal, bindScalar } from "../internal/sql.js";

/**
 * Single row from `system.parts` aggregated per (`database`, `table`).
 *
 * `parts` is the active part count — the operationally meaningful number when
 * the ClickHouse merge tree is under pressure. `bytes_on_disk` is the
 * aggregated size of those parts; surfaced as a string so JavaScript's
 * 53-bit integer ceiling can never silently truncate large clusters.
 */
export interface PartsHealthRow {
  readonly database: string;
  readonly table: string;
  readonly parts: number;
  readonly bytes_on_disk: string;
}

/**
 * Single row from `system.materialized_views` (the projection of MV state the
 * probe exposes).
 *
 * `state` mirrors the ClickHouse vocabulary. The two values the alert layer
 * cares about are `running` and `failed`; intermediate values like `idle`
 * pass through unchanged so the gauge is honest.
 */
export interface MaterializedViewStateRow {
  readonly database: string;
  readonly view: string;
  readonly state: string;
  readonly last_exception: string;
}

/**
 * Set of probes exposed by the operator-profile client.
 *
 * The probes are operator-scoped because `system.*` reads are gated by
 * `polaris_service`'s minimal grants (SELECT on projection tables and the
 * ingest log only). The role split is enforced at the ClickHouse server,
 * not in TypeScript — this surface just makes that explicit.
 */
export interface ClickHouseHealthProbes {
  /**
   * Active-parts count + on-disk bytes per (`database`, `table`). Restricted
   * to the supplied `database` name (defaults to `polaris`). Bounded by
   * `limit` so a misconfigured probe cannot scan an unbounded `system.parts`.
   */
  partsSummary(input?: PartsSummaryInput): Promise<PartsHealthRow[]>;
  /**
   * Per-view state row for every materialized view in `database`. Used by
   * the analytics-projector to emit `polaris_clickhouse_mv_state{view,state}`.
   */
  materializedViewStates(input?: MaterializedViewStatesInput): Promise<MaterializedViewStateRow[]>;
}

export interface PartsSummaryInput {
  /** Database to restrict the scan to. Defaults to `polaris`. */
  readonly database?: string;
  /** Hard cap on row count. Defaults to 100. Must be in `[1, 10_000]`. */
  readonly limit?: number;
}

export interface MaterializedViewStatesInput {
  readonly database?: string;
  readonly limit?: number;
}

const DEFAULT_DATABASE = "polaris";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;

/**
 * Build the operator-scoped probe helpers. Pure function — no I/O happens at
 * construction time; queries run when the caller invokes a probe method.
 */
export function createClickHouseHealthProbes(input: {
  underlying: UnderlyingClickHouseClient;
}): ClickHouseHealthProbes {
  const { underlying } = input;

  return {
    async partsSummary(opts) {
      const database = resolveDatabase(opts?.database);
      const limit = resolveLimit(opts?.limit);
      const sql = buildPartsSummarySql();
      const rows = await runQuery<{
        database: string;
        table: string;
        parts: number | string;
        bytes_on_disk: number | string;
      }>({
        underlying,
        query: sql,
        parameters: { database, limit },
      });
      return rows.map((row) => ({
        database: String(row.database),
        table: String(row.table),
        parts: Number(row.parts),
        bytes_on_disk: String(row.bytes_on_disk),
      }));
    },

    async materializedViewStates(opts) {
      const database = resolveDatabase(opts?.database);
      const limit = resolveLimit(opts?.limit);
      const sql = buildMaterializedViewStatesSql();
      const rows = await runQuery<{
        database: string;
        view: string;
        state: string;
        last_exception: string | null;
      }>({
        underlying,
        query: sql,
        parameters: { database, limit },
      });
      return rows.map((row) => ({
        database: String(row.database),
        view: String(row.view),
        state: String(row.state),
        last_exception: row.last_exception ?? "",
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// SQL builders (exported so unit tests can pin the shape).
// ---------------------------------------------------------------------------

/**
 * SELECT against `system.parts`. Restricted to active parts in the supplied
 * `database` — inactive parts are an internal merge artefact and would
 * inflate the row count without operational value.
 */
export function buildPartsSummarySql(): string {
  const sql = `
    SELECT
      database,
      table,
      count() AS parts,
      toString(sum(bytes_on_disk)) AS bytes_on_disk
    FROM system.parts
    WHERE database = ${bindScalar("database", "String")}
      AND active = 1
    GROUP BY database, table
    ORDER BY parts DESC, table ASC
    LIMIT ${bindScalar("limit", "UInt32")}
  `.trim();
  return assertNoFinal(sql, "probes.partsSummary");
}

/**
 * SELECT against `system.materialized_views`. ClickHouse's view-status table
 * exposes a `status` column plus the most recent exception text. We project
 * `status AS state` so the Prometheus gauge label vocabulary stays aligned
 * with the alert expression — `state="failed"` is the page condition.
 *
 * The query is tolerant of two layouts:
 *   - 24.x+ `system.materialized_views` with `last_refresh_result`
 *   - older layouts that surface state via `system.view_refreshes`
 *
 * We prefer the newer shape; the older shape is documented in the runbook.
 */
export function buildMaterializedViewStatesSql(): string {
  const sql = `
    SELECT
      database,
      view,
      state,
      last_exception
    FROM (
      SELECT
        database,
        name AS view,
        status AS state,
        coalesce(last_exception, '') AS last_exception
      FROM system.view_refreshes
      WHERE database = ${bindScalar("database", "String")}
    )
    ORDER BY view ASC
    LIMIT ${bindScalar("limit", "UInt32")}
  `.trim();
  return assertNoFinal(sql, "probes.materializedViewStates");
}

function resolveDatabase(database?: string): string {
  if (database === undefined) return DEFAULT_DATABASE;
  return assertIdentifier(database, "probes.database");
}

function resolveLimit(limit?: number): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_LIMIT) {
    throw new Error(
      `probes: limit must be an integer in [1, ${MAX_LIMIT}]; received ${String(value)}.`,
    );
  }
  return value;
}
