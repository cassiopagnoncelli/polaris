/**
 * Closed-set registry of ClickHouse projections that can be rebuilt
 * through `polaris clickhouse-rebuild`.
 *
 * The source of truth for "what is a known projection" is the
 * `sql/clickhouse/projections/` directory in the repo. This module
 * mirrors that directory in code so:
 *
 *   1. The planner refuses an unknown projection without needing a
 *      live ClickHouse — `clickhouse_unreachable` is reserved for
 *      runtime failures, not "the name doesn't exist".
 *   2. The CLI's --projection flag enumerates the closed set in its
 *      `--help` output and rejects unknown values with a usage error
 *      before any DB read or ClickHouse round-trip.
 *   3. Adding a projection is a four-step process documented in
 *      `packages/shared-clickhouse/src/projections/index.ts`; one of
 *      those steps is updating the constant below.
 *
 * Why a hand-maintained constant and not a filesystem walk: the
 * planner is a pure-function module with NO I/O. A filesystem walk
 * would couple the planner to the repo layout at runtime (the
 * `dist/` build would not have `sql/clickhouse/` next to it) and
 * would force a test seam for filesystem stubbing. The constant is
 * cheap, the four-step process keeps it in sync, and the schema
 * invariant test in `apps/polaris-cli/test/` asserts every SQL file
 * has a matching registry entry.
 *
 * @see docs/architecture/07-clickhouse.md "Projection Tables"
 * @see docs/development/clickhouse-rebuilds.md
 * @see sql/clickhouse/projections/
 */

/**
 * Metadata for one rebuildable projection.
 *
 *   `name`              the closed-set label used as the
 *                       `--projection` argument and stamped onto
 *                       `clickhouse_rebuild_jobs.target_projection`.
 *
 *   `qualifiedTable`    the `<database>.<table>` form the rebuild
 *                       executor writes to. Always `polaris.<table>`
 *                       in v1.
 *
 *   `sqlFile`           the canonical SQL file under
 *                       `sql/clickhouse/projections/` (relative to
 *                       the repo root) so docs / tooling can link
 *                       back to the source-of-truth DDL.
 *
 *   `feederMvFile`      the canonical materialized-view SQL file
 *                       under `sql/clickhouse/materialized-views/`.
 *                       The executor (deferred) replays this MV's
 *                       SELECT against `analytics_raw` to repopulate
 *                       the projection.
 *
 *   `rebuildSelectFile` the canonical INSERT-side SELECT, checked in
 *                       next to the projection DDL. The rebuild
 *                       driver reads this file at construction time
 *                       and wraps it in `INSERT INTO <table> <select>`
 *                       for each partition. Separate from
 *                       `feederMvFile` because the live MV statement
 *                       is a `CREATE MATERIALIZED VIEW … AS SELECT`
 *                       wrapper and the rebuild path needs only the
 *                       SELECT body.
 *
 *   `description`       one-line plain-English summary, shown in
 *                       `polaris clickhouse-rebuild plan` output.
 */
export interface ClickhouseProjectionDescriptor {
  readonly name: string;
  readonly qualifiedTable: string;
  readonly sqlFile: string;
  readonly feederMvFile: string;
  readonly rebuildSelectFile: string;
  readonly description: string;
}

/**
 * The closed set of rebuildable ClickHouse projections.
 *
 * Adding a new entry requires:
 *
 *   1. The DDL file at `sqlFile`.
 *   2. The feeder MV file at `feederMvFile`.
 *   3. The SELECT grant in `sql/clickhouse/roles/01_grants.sql`.
 *   4. The reader module under
 *      `packages/shared-clickhouse/src/projections/`.
 *
 * The `rebuild-projections-registry` test in
 * `apps/polaris-cli/test/clickhouse-rebuild-commands.test.ts` asserts
 * every entry's `sqlFile` resolves to a real file under
 * `sql/clickhouse/projections/`.
 */
export const REBUILDABLE_CLICKHOUSE_PROJECTIONS: readonly ClickhouseProjectionDescriptor[] = [
  {
    name: "event_daily_counts",
    qualifiedTable: "polaris.event_daily_counts",
    sqlFile: "sql/clickhouse/projections/40_event_daily_counts.sql",
    feederMvFile: "sql/clickhouse/materialized-views/41_mv_raw_to_event_daily_counts.sql",
    rebuildSelectFile: "sql/clickhouse/projections/40_event_daily_counts_rebuild.sql",
    description:
      "Per-day event counts keyed by (project_id, environment, event). SummingMergeTree.",
  },
] as const;

/**
 * The closed-set `target_projection` labels accepted by the planner
 * and the CLI. Derived from {@link REBUILDABLE_CLICKHOUSE_PROJECTIONS}
 * so the closed set only has one place to update.
 */
export const REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES: readonly string[] =
  REBUILDABLE_CLICKHOUSE_PROJECTIONS.map((p) => p.name);

/**
 * Look up the descriptor for a projection by name. Returns `null`
 * when the name is not in the closed set. The planner uses this
 * to map `unknown_projection` rejections; the CLI uses it to
 * surface the resolved qualified table name on the dry-run plan
 * output.
 */
export function findRebuildableProjection(name: string): ClickhouseProjectionDescriptor | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return REBUILDABLE_CLICKHOUSE_PROJECTIONS.find((p) => p.name === trimmed) ?? null;
}
