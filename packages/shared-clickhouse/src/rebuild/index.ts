/**
 * `@polaris/shared-clickhouse/rebuild` — ClickHouse rebuild planner.
 *
 * Pure-function module that produces a dry-run plan for a controlled
 * rebuild of one analytical projection. Consumed by:
 *
 *   - `polaris clickhouse-rebuild plan` — dry-run renderer
 *   - `polaris clickhouse-rebuild create --dry-run` — same planner,
 *     stamps `rows_estimated` / `partitions_estimated` onto the
 *     persisted dry-run row.
 *   - the eventual executor (deferred) — walks the planned partitions
 *     and runs the argMax repopulation.
 *
 * Architectural rule:
 *
 *   The planner OWNS the plan. PostgreSQL stores only the operator's
 *   declaration; the plan is recomputed on demand from the
 *   declaration plus a snapshot of `system.parts`. To change planning
 *   behaviour, bump `plannerVersion` and ship a new release.
 *
 * @see docs/architecture/07-clickhouse.md "Replay and Rebuild"
 * @see docs/development/clickhouse-rebuilds.md
 */

export type { ClickhouseProjectionDescriptor } from "./projections.js";
export {
  findRebuildableProjection,
  REBUILDABLE_CLICKHOUSE_PROJECTIONS,
  REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES,
} from "./projections.js";

export { planClickhouseRebuild } from "./planner.js";
export { renderClickhouseRebuildPlanHuman } from "./render.js";

export type {
  ClickhouseRebuildDeclaration,
  ClickhouseRebuildPlan,
  ClickhouseRebuildPlanned,
  ClickhouseRebuildRejected,
  ClickhouseRebuildRejectionCode,
  PartsSummary,
  PlanClickhouseRebuildOptions,
} from "./types.js";
export { CLICKHOUSE_REBUILD_REJECTION_CODES } from "./types.js";
