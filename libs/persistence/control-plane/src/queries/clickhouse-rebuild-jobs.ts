/**
 * Repository helpers for the `clickhouse_rebuild_jobs` table.
 *
 * ClickHouse rebuild jobs are durable operator-issued requests to
 * re-derive an analytical projection. PostgreSQL holds the row
 * (runtime state + audit trail); the planner that turns the row into
 * a deterministic dry-run plan lives in
 * `@polaris/shared-clickhouse/rebuild`.
 *
 * The typed `ClickhouseRebuildJobsTable` interface extends
 * `@polaris/shared-db`'s `Database` interface through module
 * augmentation — the same pattern `replay-jobs.ts` (P7-001) and
 * `topic-isolations.ts` (P11-008) use. This keeps the migration SQL
 * the schema source-of-truth while letting this task extend the
 * typed surface without an inter-package edit.
 *
 * Rules baked into this module:
 *
 *   - The repository surface NEVER accepts executor-side fields. The
 *     `InsertClickhouseRebuildJobInput` interface has no
 *     `partition_strategy`, `chunking_rules`, `replica_target`, or
 *     similar fields. The migration's column set matches this
 *     contract; the typed surface refuses to write them at compile
 *     time.
 *
 *   - Status transitions are guarded by WHERE clauses on the
 *     previous status. The command-layer state machine decides which
 *     transitions are valid; this module's setters reject zero-row
 *     UPDATEs by returning `false`, leaving the caller to surface
 *     "already aborted" idempotently.
 *
 *   - Failure stamping (`error_class` / `error_message` /
 *     `status='failed'`) is owned by the deferred executor, not this
 *     module. The migration's CHECK constraints enforce the
 *     consistency rules; this module ships only the operator-facing
 *     `create` / `abort` setters needed by P7-005.
 *
 * @see db/migrations/20260515000001_create_clickhouse_rebuild_jobs.sql
 * @see libs/persistence/clickhouse/src/rebuild/
 * @see docs/development/clickhouse-rebuilds.md
 */
import type { Database } from "@polaris/shared-db";
import type { ColumnType, Kysely } from "kysely";

/**
 * Closed set of `clickhouse_rebuild_jobs.status` values, mirroring
 * the `clickhouse_rebuild_jobs_status_allowed` CHECK in the migration.
 *
 * State machine (full):
 *
 *   pending  --> planning (deferred planner picks up the job)
 *   planning --> dry_run  (operator requested --dry-run)
 *   planning --> running  (live rebuild; executor DEFERRED in v1)
 *   <any non-terminal> --> aborted (operator-issued)
 *   running --> completed | failed (executor-issued; DEFERRED)
 *
 * `completed`, `failed`, and `aborted` are terminal: the CLI rejects
 * further mutations on jobs in those states.
 */
export const CLICKHOUSE_REBUILD_JOB_STATUSES = [
  "pending",
  "planning",
  "dry_run",
  "running",
  "completed",
  "failed",
  "aborted",
] as const;
export type ClickhouseRebuildJobStatus = (typeof CLICKHOUSE_REBUILD_JOB_STATUSES)[number];

/**
 * Statuses that are terminal from the CLI surface. Jobs in these
 * states are immutable; `abort` returns `already_terminal` for any
 * of them.
 */
export const TERMINAL_CLICKHOUSE_REBUILD_JOB_STATUSES: readonly ClickhouseRebuildJobStatus[] = [
  "completed",
  "failed",
  "aborted",
] as const;

export function isTerminalClickhouseRebuildStatus(status: ClickhouseRebuildJobStatus): boolean {
  return TERMINAL_CLICKHOUSE_REBUILD_JOB_STATUSES.includes(status);
}

/**
 * Statuses from which `abort` is allowed. Mirrors the task card's
 * "Allowed only from `pending` or `planning`" rule, plus `dry_run`
 * (a `dry_run` row with `aborted` is the operator's way of
 * documenting "I considered this rebuild and decided against it").
 */
export const ABORTABLE_CLICKHOUSE_REBUILD_JOB_STATUSES: readonly ClickhouseRebuildJobStatus[] = [
  "pending",
  "planning",
  "dry_run",
] as const;

export function isAbortableClickhouseRebuildStatus(status: ClickhouseRebuildJobStatus): boolean {
  return ABORTABLE_CLICKHOUSE_REBUILD_JOB_STATUSES.includes(status);
}

/**
 * Typed mirror of the `clickhouse_rebuild_jobs` table. The optional
 * range and error columns admit NULL; estimates are bigint /
 * integer on the database side. The CLI surface narrows them to
 * `number` (see `toRow` for the explicit narrowing) because realistic
 * rebuild estimates are far below 2^53.
 */
export interface ClickhouseRebuildJobsTable {
  clickhouse_rebuild_job_id: string;
  target_projection: string;
  target_table_qualified: string;
  source_range_from: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  source_range_to: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  reason: string;
  requester_actor_label: string;
  status: ColumnType<
    ClickhouseRebuildJobStatus,
    ClickhouseRebuildJobStatus | undefined,
    ClickhouseRebuildJobStatus
  >;
  rows_estimated: ColumnType<
    bigint | number | string | null,
    bigint | number | string | null | undefined,
    bigint | number | string | null
  >;
  partitions_estimated: ColumnType<number | null, number | null | undefined, number | null>;
  error_class: ColumnType<string | null, string | null | undefined, string | null>;
  error_message: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
  started_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  completed_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

declare module "@polaris/shared-db" {
  interface Database {
    clickhouse_rebuild_jobs: ClickhouseRebuildJobsTable;
  }
}

/**
 * Read-shape returned to the command layer. Plain JSON: timestamps
 * are stamped as ISO strings; estimates narrow to `number` (nullable).
 */
export interface ClickhouseRebuildJobRow {
  readonly clickhouse_rebuild_job_id: string;
  readonly target_projection: string;
  readonly target_table_qualified: string;
  readonly source_range_from: string | null;
  readonly source_range_to: string | null;
  readonly reason: string;
  readonly requester_actor_label: string;
  readonly status: ClickhouseRebuildJobStatus;
  readonly rows_estimated: number | null;
  readonly partitions_estimated: number | null;
  readonly error_class: string | null;
  readonly error_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

/**
 * Insert payload accepted by {@link insertClickhouseRebuildJob}. Caller
 * has already generated the id, validated the closed-set projection
 * label, and resolved the actor label.
 *
 * `status` is OPTIONAL; the schema default is `'pending'`. The CLI
 * passes `'dry_run'` when --dry-run was set. `rows_estimated` /
 * `partitions_estimated` come from the planner — both nullable so
 * the planner's `clickhouse_unreachable` rejection path can still
 * write a row (in P7-005 it never does, but the column shape is
 * stable for the deferred executor).
 */
export interface InsertClickhouseRebuildJobInput {
  readonly clickhouse_rebuild_job_id: string;
  readonly target_projection: string;
  readonly target_table_qualified: string;
  readonly source_range_from?: Date | null;
  readonly source_range_to?: Date | null;
  readonly reason: string;
  readonly requester_actor_label: string;
  readonly status?: ClickhouseRebuildJobStatus;
  readonly rows_estimated?: number | null;
  readonly partitions_estimated?: number | null;
}

/**
 * INSERT a freshly-issued rebuild-job row. `status` defaults to the
 * schema default (`'pending'`) when omitted; the CLI passes
 * `'dry_run'` for --dry-run rows. `created_at` / `updated_at` come
 * from the server clock.
 */
export async function insertClickhouseRebuildJob(
  db: Kysely<Database>,
  input: InsertClickhouseRebuildJobInput,
): Promise<void> {
  const values: {
    clickhouse_rebuild_job_id: string;
    target_projection: string;
    target_table_qualified: string;
    source_range_from: Date | null;
    source_range_to: Date | null;
    reason: string;
    requester_actor_label: string;
    status?: ClickhouseRebuildJobStatus;
    rows_estimated: number | string | null;
    partitions_estimated: number | null;
  } = {
    clickhouse_rebuild_job_id: input.clickhouse_rebuild_job_id,
    target_projection: input.target_projection,
    target_table_qualified: input.target_table_qualified,
    source_range_from: input.source_range_from ?? null,
    source_range_to: input.source_range_to ?? null,
    reason: input.reason,
    requester_actor_label: input.requester_actor_label,
    rows_estimated: input.rows_estimated ?? null,
    partitions_estimated: input.partitions_estimated ?? null,
  };
  if (input.status !== undefined) {
    values.status = input.status;
  }
  await db.insertInto("clickhouse_rebuild_jobs").values(values).execute();
}

/**
 * Look up one row by id. Used by `show`, `abort`, and the future
 * planner. Returns `null` for unknown ids.
 */
export async function findClickhouseRebuildJobById(
  db: Kysely<Database>,
  jobId: string,
): Promise<ClickhouseRebuildJobRow | null> {
  const row = await db
    .selectFrom("clickhouse_rebuild_jobs")
    .selectAll()
    .where("clickhouse_rebuild_job_id", "=", jobId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * Filter accepted by `polaris clickhouse-rebuild list`. All fields
 * optional and combined with AND.
 */
export interface ListClickhouseRebuildJobsFilter {
  readonly status?: ClickhouseRebuildJobStatus;
  readonly projection?: string;
  readonly limit?: number;
}

/**
 * Return rebuild-job rows matching the supplied filter, ordered by
 * `created_at DESC`. Default limit is 50.
 */
export async function listClickhouseRebuildJobs(
  db: Kysely<Database>,
  filter: ListClickhouseRebuildJobsFilter,
): Promise<ClickhouseRebuildJobRow[]> {
  let query = db.selectFrom("clickhouse_rebuild_jobs").selectAll();
  if (filter.status !== undefined) {
    query = query.where("status", "=", filter.status);
  }
  if (filter.projection !== undefined) {
    query = query.where("target_projection", "=", filter.projection);
  }
  const limit = filter.limit ?? 50;
  query = query.orderBy("created_at", "desc").limit(limit);
  const rows = await query.execute();
  return rows.map(toRow);
}

/**
 * Transition a rebuild job to `'running'` and stamp `started_at` +
 * `updated_at` (GWNZH1N5). The WHERE clause restricts the update to
 * rows whose status is currently `'pending'`; passing any other
 * status returns the existing row's current status without
 * mutating it.
 *
 * Returns the row's status after the attempted update (matching the
 * `ClickhouseRebuildStore.markRunning` contract in
 * `@polaris/shared-clickhouse/rebuild`), or `null` when the row no
 * longer exists.
 */
export async function markClickhouseRebuildJobRunning(
  db: Kysely<Database>,
  jobId: string,
  now: Date,
): Promise<{ readonly status: ClickhouseRebuildJobStatus } | null> {
  const updated = await db
    .updateTable("clickhouse_rebuild_jobs")
    .set({
      status: "running",
      started_at: now,
      updated_at: now,
    })
    .where("clickhouse_rebuild_job_id", "=", jobId)
    .where("status", "=", "pending")
    .returning("status")
    .executeTakeFirst();
  if (updated !== undefined) {
    return { status: updated.status };
  }
  const existing = await db
    .selectFrom("clickhouse_rebuild_jobs")
    .select("status")
    .where("clickhouse_rebuild_job_id", "=", jobId)
    .executeTakeFirst();
  return existing === undefined ? null : { status: existing.status };
}

/**
 * Transition a rebuild job to `'completed'` and stamp `completed_at`
 * + `updated_at` + `rows_estimated` (re-using the column to record
 * the actual rows inserted; the schema lets the column carry the
 * post-run actual). The WHERE clause restricts to `'running'` rows
 * so a peer-aborted row never moves to `completed`.
 */
export async function markClickhouseRebuildJobCompleted(
  db: Kysely<Database>,
  jobId: string,
  now: Date,
  rowsInserted: number,
): Promise<{ readonly status: ClickhouseRebuildJobStatus } | null> {
  const updated = await db
    .updateTable("clickhouse_rebuild_jobs")
    .set({
      status: "completed",
      completed_at: now,
      updated_at: now,
      rows_estimated: rowsInserted,
    })
    .where("clickhouse_rebuild_job_id", "=", jobId)
    .where("status", "=", "running")
    .returning("status")
    .executeTakeFirst();
  if (updated !== undefined) {
    return { status: updated.status };
  }
  const existing = await db
    .selectFrom("clickhouse_rebuild_jobs")
    .select("status")
    .where("clickhouse_rebuild_job_id", "=", jobId)
    .executeTakeFirst();
  return existing === undefined ? null : { status: existing.status };
}

/**
 * Transition a rebuild job to `'failed'` with `error_class` +
 * `error_message` per the migration's CHECK constraints. WHERE
 * clause restricts to `'running'` rows.
 */
export async function markClickhouseRebuildJobFailed(
  db: Kysely<Database>,
  jobId: string,
  now: Date,
  errorClass: string,
  errorMessage: string,
): Promise<{ readonly status: ClickhouseRebuildJobStatus } | null> {
  const updated = await db
    .updateTable("clickhouse_rebuild_jobs")
    .set({
      status: "failed",
      completed_at: now,
      updated_at: now,
      error_class: errorClass,
      error_message: errorMessage,
    })
    .where("clickhouse_rebuild_job_id", "=", jobId)
    .where("status", "=", "running")
    .returning("status")
    .executeTakeFirst();
  if (updated !== undefined) {
    return { status: updated.status };
  }
  const existing = await db
    .selectFrom("clickhouse_rebuild_jobs")
    .select("status")
    .where("clickhouse_rebuild_job_id", "=", jobId)
    .executeTakeFirst();
  return existing === undefined ? null : { status: existing.status };
}

/**
 * Transition a rebuild job to `'aborted'` and stamp
 * `completed_at` + `updated_at`. The WHERE clause restricts the
 * update to rows whose status is currently abortable; passing a
 * terminal row returns `false` so callers can surface
 * "already terminal" idempotently.
 */
export async function abortClickhouseRebuildJob(
  db: Kysely<Database>,
  jobId: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("clickhouse_rebuild_jobs")
    .set({
      status: "aborted",
      completed_at: now,
      updated_at: now,
    })
    .where("clickhouse_rebuild_job_id", "=", jobId)
    .where("status", "in", [...ABORTABLE_CLICKHOUSE_REBUILD_JOB_STATUSES])
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

function toRow(row: {
  readonly clickhouse_rebuild_job_id: string;
  readonly target_projection: string;
  readonly target_table_qualified: string;
  readonly source_range_from: Date | null;
  readonly source_range_to: Date | null;
  readonly reason: string;
  readonly requester_actor_label: string;
  readonly status: ClickhouseRebuildJobStatus;
  readonly rows_estimated: bigint | number | string | null;
  readonly partitions_estimated: number | null;
  readonly error_class: string | null;
  readonly error_message: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
}): ClickhouseRebuildJobRow {
  return {
    clickhouse_rebuild_job_id: row.clickhouse_rebuild_job_id,
    target_projection: row.target_projection,
    target_table_qualified: row.target_table_qualified,
    source_range_from: row.source_range_from === null ? null : row.source_range_from.toISOString(),
    source_range_to: row.source_range_to === null ? null : row.source_range_to.toISOString(),
    reason: row.reason,
    requester_actor_label: row.requester_actor_label,
    status: row.status,
    rows_estimated: row.rows_estimated === null ? null : toNumber(row.rows_estimated),
    partitions_estimated: row.partitions_estimated,
    error_class: row.error_class,
    error_message: row.error_message,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    started_at: row.started_at === null ? null : row.started_at.toISOString(),
    completed_at: row.completed_at === null ? null : row.completed_at.toISOString(),
  };
}

function toNumber(value: bigint | number | string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.parseInt(value, 10);
}
