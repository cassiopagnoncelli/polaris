/**
 * Public types for the ClickHouse rebuild planner.
 *
 * The planner is a pure-function module that turns an operator-issued
 * rebuild-job declaration into a deterministic, dry-run-only **plan**.
 * Consumers:
 *
 *   - `polaris clickhouse-rebuild plan` / `... create --dry-run` —
 *     renders the plan to the operator before any data moves.
 *   - the executor (deferred to a follow-up task) — will consume the
 *     same plan to drive an `INSERT … SELECT argMax(…, _version) FROM
 *     polaris.analytics_raw GROUP BY (project_id, environment, event,
 *     event_id)` partition-by-partition walk.
 *
 * Architectural rule baked into this module:
 *
 *   The planner OWNS the plan. PostgreSQL stores ONLY the rebuild-job
 *   declaration (projection, optional range, reason, requester, status,
 *   outcome). The plan itself — partition list, rough row estimate,
 *   known gaps — is recomputed from the declaration each time it is
 *   needed by reading `system.parts` through the existing shared client.
 *
 * The planner is permitted ONE ClickHouse round-trip: a SELECT against
 * `system.parts` to enumerate partitions and rough row counts for the
 * planning estimate. It NEVER writes to ClickHouse and NEVER reads from
 * the target projection or `analytics_raw`. This keeps `--dry-run`
 * idempotent and safe to call against production.
 *
 * @see docs/architecture/07-clickhouse.md "Replay and Rebuild"
 * @see docs/development/clickhouse-rebuilds.md
 * @see docs/implementation/tasks/P7-005-clickhouse-rebuild-workflows.md
 */

import type { ClickhouseProjectionDescriptor } from "./projections.js";

/**
 * Closed-set rejection codes the planner emits. Each maps to a
 * structured error consumers can branch on without string matching.
 *
 *   `unknown_projection`     `projection` is not in the closed set
 *                            defined by
 *                            {@link REBUILDABLE_CLICKHOUSE_PROJECTIONS}.
 *
 *   `invalid_range`          `fromTs` / `toTs` is malformed, paired
 *                            partially (only one supplied), or
 *                            inverted (`toTs < fromTs`).
 *
 *   `range_empty`            `fromTs === toTs`. A zero-width window
 *                            cannot select any partitions, so the
 *                            planner refuses rather than emit an
 *                            empty plan and let the operator believe
 *                            anything ran.
 *
 *   `clickhouse_unreachable` the planner could not reach ClickHouse
 *                            to enumerate `system.parts`. Distinct
 *                            from `unknown_projection` so the CLI
 *                            output tells the operator whether the
 *                            problem is "wrong name" vs "infra".
 */
export const CLICKHOUSE_REBUILD_REJECTION_CODES = [
  "unknown_projection",
  "invalid_range",
  "range_empty",
  "clickhouse_unreachable",
] as const;
export type ClickhouseRebuildRejectionCode = (typeof CLICKHOUSE_REBUILD_REJECTION_CODES)[number];

/**
 * Operator-issued declaration handed to the planner. Mirrors the
 * `clickhouse_rebuild_jobs` row (minus the lifecycle timestamps,
 * status, and error columns). The planner accepts a JS object so it
 * can be invoked from the CLI BEFORE any DB INSERT happens — the
 * dry-run flow never persists a row, and the create flow uses the
 * planner output to populate `rows_estimated` / `partitions_estimated`
 * in the row it writes.
 */
export interface ClickhouseRebuildDeclaration {
  /** Closed-set projection label. */
  readonly projection: string;
  /**
   * Inclusive bounded source range start. Together with `toTs`,
   * defines a sub-window for the rebuild. Both NULL means "full
   * table". Mixed (one NULL, one set) is rejected with
   * `invalid_range`.
   */
  readonly fromTs?: Date | string | null;
  /** Inclusive bounded source range end. See `fromTs`. */
  readonly toTs?: Date | string | null;
}

/**
 * Options accepted by {@link planClickhouseRebuild}. Tests and the
 * CLI's dry-run command inject the parts source so the planner does
 * not need a real ClickHouse during unit tests.
 *
 * `now` is used to stamp `plannedAt` in the rendered output so
 * `--dry-run` is deterministic when tests pin the clock.
 */
export interface PlanClickhouseRebuildOptions {
  /**
   * Optional adapter that returns `system.parts` summaries for the
   * target table. When omitted, the planner returns `kind: "rejected"`
   * with `clickhouse_unreachable`. Splitting this dependency out
   * (rather than taking a `ClickHouseOperatorClient`) keeps the
   * planner's type surface free of the operator-profile client so
   * tests are trivial and the planner stays import-cheap.
   */
  readonly readPartitions?: (input: {
    readonly qualifiedTable: string;
    readonly fromTs: Date | null;
    readonly toTs: Date | null;
  }) => Promise<PartsSummary>;
  /** Wall-clock used for `plannedAt`. Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Per-partition row count summary the planner needs from
 * `system.parts`. Implementations may aggregate parts within a
 * partition; the planner only consumes one row per partition.
 */
export interface PartsSummary {
  readonly partitions: ReadonlyArray<{
    readonly partition: string;
    readonly rowsEstimated: number;
  }>;
  /**
   * Free-form list of caveats the partition-reader wants to surface.
   * Examples: "skipped partition 202604 (inactive parts only)",
   * "system.parts row count includes pre-merge duplicates".
   * Forwarded onto the plan output verbatim.
   */
  readonly knownGaps?: ReadonlyArray<string>;
}

/**
 * Successful plan. The executor (deferred) consumes this plus the
 * row's id to drive the rebuild; the CLI's `--dry-run` flow renders
 * it directly.
 */
export interface ClickhouseRebuildPlanned {
  readonly kind: "planned";
  /** Echo of the projection label so consumers don't thread it. */
  readonly projection: string;
  /** Resolved descriptor from the closed-set registry. */
  readonly descriptor: ClickhouseProjectionDescriptor;
  /** Fully-qualified target table (`polaris.<table>`). */
  readonly targetTableQualified: string;
  /** Effective range, ISO strings or `null` for full-table. */
  readonly sourceRangeFrom: string | null;
  readonly sourceRangeTo: string | null;
  /** Per-partition row-count estimate. */
  readonly partitions: ReadonlyArray<{
    readonly partition: string;
    readonly rowsEstimated: number;
  }>;
  /** Sum of `partitions[i].rowsEstimated`. */
  readonly rowsTotalEstimated: number;
  /** Number of partitions to rebuild. Equal to `partitions.length`. */
  readonly partitionCount: number;
  /** Caveats from the partition reader, deduped + ordered. */
  readonly knownGaps: ReadonlyArray<string>;
  /**
   * Planner clock stamp (ISO 8601 UTC). Tests pin this with the
   * `now` option so dry-run output is deterministic.
   */
  readonly plannedAt: string;
  /**
   * Stable contract version. Bumps when the plan shape changes.
   */
  readonly plannerVersion: "v1";
}

/**
 * Rejected plan. Carries a closed-set `code` so the CLI can branch
 * on it deterministically.
 */
export interface ClickhouseRebuildRejected {
  readonly kind: "rejected";
  readonly code: ClickhouseRebuildRejectionCode;
  readonly message: string;
}

export type ClickhouseRebuildPlan = ClickhouseRebuildPlanned | ClickhouseRebuildRejected;
