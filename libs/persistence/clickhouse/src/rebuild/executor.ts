/**
 * ClickHouse projection-rebuild executor (GWNZH1N5).
 *
 * Drives one `pending` rebuild row through the lifecycle the
 * `clickhouse_rebuild_jobs` schema enforces:
 *
 *   pending → running → completed
 *                    \→ failed
 *
 * The executor itself is pure orchestration. The actual ClickHouse
 * side-effects (clearing the projection's slice, re-running the
 * feeder MV's SELECT to repopulate it) are owned by a
 * {@link ClickhouseRebuildDriver}. Production wires a driver around
 * the operator-profile ClickHouse client; tests pass a synthetic
 * driver. This mirrors the orchestrator-with-injected-adapters shape
 * that the replay executor in `@polaris/archive-replay` uses.
 *
 * The {@link ClickhouseRebuildStore} contract receives the lifecycle
 * transitions — `markRunning`, `markCompleted`, `markFailed`. It is
 * intentionally a thin trio so the polaris-cli's Kysely-backed
 * implementation can carry the WHERE-status guards that prevent
 * accidental status thrash; the executor only needs to know whether
 * the transition succeeded.
 *
 * Refusals (driver throws, projection not in the closed set) drive
 * `markFailed` with the error class + message; the run still
 * resolves rather than throwing so the calling CLI command can
 * surface a stable structured exit. Aborts mid-flight return the
 * `aborted` terminal status from the store's transition guard so
 * the caller's exit code reflects that the run did not complete.
 *
 * @see db/postgres/migrations/20260515000001_create_clickhouse_rebuild_jobs.sql
 * @see libs/persistence/clickhouse/src/rebuild/planner.ts
 */

import { findRebuildableProjection } from "./projections.js";
import type { ClickhouseRebuildPlanned } from "./types.js";

/** Stable contract version stamped on the outcome. */
export const REBUILD_EXECUTOR_VERSION = "v1" as const;

/**
 * Status the executor's outcome carries. Mirrors a subset of the
 * `clickhouse_rebuild_job_status` enum; the executor never emits
 * `pending`, `planning`, or `dry_run` — those are pre-executor
 * states the caller is responsible for.
 */
export type ClickhouseRebuildOutcomeStatus = "completed" | "failed" | "aborted";

/**
 * Final outcome the caller persists / surfaces. The store-level
 * transition has already happened by the time the outcome is
 * returned; this is the read-only structured receipt.
 */
export interface ClickhouseRebuildOutcome {
  readonly clickhouse_rebuild_job_id: string;
  readonly status: ClickhouseRebuildOutcomeStatus;
  /** Started_at (ISO 8601 UTC) — when the executor flipped to `running`. */
  readonly started_at: string;
  /** Finished_at (ISO 8601 UTC). Always set when status is terminal. */
  readonly finished_at: string;
  /** Per-partition row counts the driver reported, in execution order. */
  readonly partitions: ReadonlyArray<{
    readonly partition: string;
    readonly rows_inserted: number;
  }>;
  /** Sum of `partitions[i].rows_inserted`. */
  readonly rows_inserted_total: number;
  /** Error captured when status === 'failed'. */
  readonly error: { readonly error_class: string; readonly error_message: string } | null;
  /** Stable contract version stamp. */
  readonly executor_version: typeof REBUILD_EXECUTOR_VERSION;
}

/**
 * Lifecycle store the executor calls. Implementations:
 *
 *   - production: a Kysely-backed adapter in the polaris-cli that
 *     wraps `clickhouse_rebuild_jobs` with the WHERE-status guards.
 *   - tests: an in-memory adapter that records each transition for
 *     assertion.
 */
export interface ClickhouseRebuildStore {
  /**
   * Transition `pending` → `running`. Returns the row's status after
   * the attempted update. The executor refuses to ship a row whose
   * status is anything other than `running` after this call.
   */
  markRunning(input: {
    readonly clickhouse_rebuild_job_id: string;
    readonly now: Date;
  }): Promise<ClickhouseRebuildStoreStatus | null>;
  /** Transition `running` → `completed`. */
  markCompleted(input: {
    readonly clickhouse_rebuild_job_id: string;
    readonly now: Date;
    readonly rows_inserted: number;
  }): Promise<ClickhouseRebuildStoreStatus | null>;
  /** Transition `running` → `failed` with the captured error pair. */
  markFailed(input: {
    readonly clickhouse_rebuild_job_id: string;
    readonly now: Date;
    readonly error_class: string;
    readonly error_message: string;
  }): Promise<ClickhouseRebuildStoreStatus | null>;
}

/**
 * Snapshot the store returns after each transition. `null` from any
 * `mark*` method means the row was deleted between operations; the
 * executor treats that as an `aborted` outcome.
 */
export interface ClickhouseRebuildStoreStatus {
  readonly status:
    | "pending"
    | "planning"
    | "dry_run"
    | "running"
    | "completed"
    | "failed"
    | "aborted";
}

/**
 * The driver does the actual ClickHouse work. Production wires it
 * around the operator-profile ClickHouse client (`createClickHouseClient
 * { role: "operator" }`); the implementation lives in the polaris-cli
 * alongside the rest of the operator-side ClickHouse helpers.
 *
 * Per-method contract:
 *
 *   - `clearSlice(input)` removes the projection rows that the
 *     rebuild is about to repopulate. For a full-table rebuild
 *     (both `sourceRangeFrom` / `sourceRangeTo` null) this is a
 *     `TRUNCATE`; for a range, it is a partition-aware `ALTER TABLE
 *     ... DELETE` (synchronous mutation) that matches the planner's
 *     partition set.
 *
 *   - `rebuildPartition(input)` repopulates one partition by
 *     re-executing the feeder MV's SELECT against `analytics_raw`
 *     and INSERT-ing into the projection. Returns the number of
 *     rows inserted so the executor can stamp the outcome.
 *
 * Both methods may throw. The executor catches and routes to
 * `markFailed`.
 */
export interface ClickhouseRebuildDriver {
  clearSlice(input: ClearSliceInput): Promise<void>;
  rebuildPartition(input: RebuildPartitionInput): Promise<{ readonly rows_inserted: number }>;
}

export interface ClearSliceInput {
  readonly qualifiedTable: string;
  /** Same null = full-table contract as the planner. */
  readonly sourceRangeFrom: string | null;
  readonly sourceRangeTo: string | null;
  readonly partitions: ReadonlyArray<string>;
}

export interface RebuildPartitionInput {
  readonly qualifiedTable: string;
  /** Feeder MV SQL file path the planner pinned. Carried for audit/logging. */
  readonly feederMvFile: string;
  /**
   * Path to the canonical INSERT-side SELECT for this projection. The
   * driver reads the file once at construction and looks up the
   * SELECT body by this path — this is just the lookup key.
   */
  readonly rebuildSelectFile: string;
  readonly partition: string;
  readonly sourceRangeFrom: string | null;
  readonly sourceRangeTo: string | null;
}

export interface ExecuteClickhouseRebuildInput {
  /** Planned row to drive. The caller has already persisted the `pending` row. */
  readonly plan: ClickhouseRebuildPlanned;
  /** Job id of the persisted row. */
  readonly clickhouse_rebuild_job_id: string;
  /** Lifecycle store. */
  readonly store: ClickhouseRebuildStore;
  /** ClickHouse driver. */
  readonly driver: ClickhouseRebuildDriver;
  /**
   * Clock injected for determinism. Defaults to `() => new Date()`.
   * Production wires this through the CLI's clock seam so tests see
   * deterministic timestamps.
   */
  readonly now?: () => Date;
}

/**
 * Closed set of refusal codes. Distinct from the planner's
 * `ClickhouseRebuildRejectionCode` — the planner refuses BEFORE a
 * row exists; the executor refuses AFTER a `pending` row has been
 * persisted.
 */
export const CLICKHOUSE_REBUILD_EXECUTOR_REFUSAL_CODES = [
  "row_already_terminal",
  "row_missing",
  "projection_not_rebuildable",
] as const;
export type ClickhouseRebuildExecutorRefusalCode =
  (typeof CLICKHOUSE_REBUILD_EXECUTOR_REFUSAL_CODES)[number];

/**
 * Refusal raised when the executor cannot start. Distinct from the
 * `failed` terminal: a refusal happens BEFORE the store transition
 * to `running`, so no row gets stamped with the error pair.
 */
export class ClickhouseRebuildExecutorError extends Error {
  public override readonly name = "ClickhouseRebuildExecutorError";
  public readonly code: ClickhouseRebuildExecutorRefusalCode;
  constructor(code: ClickhouseRebuildExecutorRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Execute one ClickHouse projection rebuild.
 *
 * The caller (the polaris-cli) has already:
 *
 *   1. Planned the rebuild via `planClickhouseRebuild`.
 *   2. Persisted a `pending` row + audit trail.
 *
 * This function takes the plan + the row id and drives the rest of
 * the lifecycle. The outcome is returned regardless of success — the
 * caller surfaces a stable structured exit code from
 * `outcome.status`.
 */
export async function executeClickhouseRebuild(
  input: ExecuteClickhouseRebuildInput,
): Promise<ClickhouseRebuildOutcome> {
  const nowFn = input.now ?? ((): Date => new Date());
  const startedAt = nowFn();
  const startedAtIso = startedAt.toISOString();
  const jobId = input.clickhouse_rebuild_job_id;

  // ---- pre-flight refusals -------------------------------------------
  const descriptor = findRebuildableProjection(input.plan.projection);
  if (descriptor === null) {
    throw new ClickhouseRebuildExecutorError(
      "projection_not_rebuildable",
      `executor refuses to rebuild '${input.plan.projection}': not in the closed set`,
    );
  }

  // ---- mark running --------------------------------------------------
  const transition = await input.store.markRunning({
    clickhouse_rebuild_job_id: jobId,
    now: startedAt,
  });
  if (transition === null) {
    throw new ClickhouseRebuildExecutorError(
      "row_missing",
      `executor refuses to ship: clickhouse_rebuild_job ${jobId} no longer exists`,
    );
  }
  if (transition.status === "aborted") {
    // Peer-aborted before we started. The store has stamped the row;
    // surface the aborted outcome so the CLI's exit code reflects it.
    const finishedAt = nowFn();
    return {
      clickhouse_rebuild_job_id: jobId,
      status: "aborted",
      started_at: startedAtIso,
      finished_at: finishedAt.toISOString(),
      partitions: [],
      rows_inserted_total: 0,
      error: null,
      executor_version: REBUILD_EXECUTOR_VERSION,
    };
  }
  if (transition.status !== "running") {
    throw new ClickhouseRebuildExecutorError(
      "row_already_terminal",
      `executor refuses to ship: clickhouse_rebuild_job ${jobId} is in ${transition.status} state`,
    );
  }

  // ---- drive the rebuild ---------------------------------------------
  const partitionLabels = input.plan.partitions.map((p) => p.partition);
  const partitionOutcomes: Array<{ readonly partition: string; readonly rows_inserted: number }> =
    [];

  try {
    await input.driver.clearSlice({
      qualifiedTable: descriptor.qualifiedTable,
      sourceRangeFrom: input.plan.sourceRangeFrom,
      sourceRangeTo: input.plan.sourceRangeTo,
      partitions: partitionLabels,
    });
    for (const partition of partitionLabels) {
      const { rows_inserted } = await input.driver.rebuildPartition({
        qualifiedTable: descriptor.qualifiedTable,
        feederMvFile: descriptor.feederMvFile,
        rebuildSelectFile: descriptor.rebuildSelectFile,
        partition,
        sourceRangeFrom: input.plan.sourceRangeFrom,
        sourceRangeTo: input.plan.sourceRangeTo,
      });
      partitionOutcomes.push({ partition, rows_inserted });
    }
  } catch (err) {
    const finishedAt = nowFn();
    const summary = summarizeError(err);
    await input.store.markFailed({
      clickhouse_rebuild_job_id: jobId,
      now: finishedAt,
      error_class: summary.error_class,
      error_message: summary.error_message,
    });
    return {
      clickhouse_rebuild_job_id: jobId,
      status: "failed",
      started_at: startedAtIso,
      finished_at: finishedAt.toISOString(),
      partitions: partitionOutcomes,
      rows_inserted_total: sumRowsInserted(partitionOutcomes),
      error: summary,
      executor_version: REBUILD_EXECUTOR_VERSION,
    };
  }

  // ---- mark completed ------------------------------------------------
  const completedAt = nowFn();
  const rowsInsertedTotal = sumRowsInserted(partitionOutcomes);
  await input.store.markCompleted({
    clickhouse_rebuild_job_id: jobId,
    now: completedAt,
    rows_inserted: rowsInsertedTotal,
  });
  return {
    clickhouse_rebuild_job_id: jobId,
    status: "completed",
    started_at: startedAtIso,
    finished_at: completedAt.toISOString(),
    partitions: partitionOutcomes,
    rows_inserted_total: rowsInsertedTotal,
    error: null,
    executor_version: REBUILD_EXECUTOR_VERSION,
  };
}

function sumRowsInserted(parts: ReadonlyArray<{ readonly rows_inserted: number }>): number {
  let total = 0;
  for (const p of parts) total += p.rows_inserted;
  return total;
}

function summarizeError(err: unknown): {
  readonly error_class: string;
  readonly error_message: string;
} {
  if (err instanceof Error) {
    return {
      error_class: err.name.length <= 128 ? err.name : err.name.slice(0, 128),
      error_message: err.message.length <= 4096 ? err.message : err.message.slice(0, 4096),
    };
  }
  return { error_class: "Error", error_message: String(err).slice(0, 4096) };
}
