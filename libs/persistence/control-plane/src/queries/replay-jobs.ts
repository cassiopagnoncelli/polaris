/**
 * Repository helpers for the `replay_jobs` table.
 *
 * Replay JOBS are runtime state (operator-issued request + lifecycle). The
 * semantic plan that decides WHAT gets replayed lives in code under the
 * planner package shipped by P7-002. This module owns the typed Kysely
 * SELECT / INSERT / UPDATE shapes for the JOB record; it has no notion of
 * partition strategy, chunking rules, or transform overrides because those
 * are not stored here.
 *
 * The typed `ReplayJobsTable` interface extends `@polaris/shared-db`'s
 * `Database` interface through module augmentation (the `declare module`
 * below) — the same pattern `audit-records.ts` (P6-006) and
 * `operator-tokens.ts` (P6-007) use. This keeps the migration SQL the
 * schema source-of-truth while letting this task extend the typed surface
 * without an inter-package edit.
 *
 * Rules baked into this module:
 *
 *   - The repository surface NEVER accepts planner-semantic fields. The
 *     `InsertReplayJobInput` interface has no `partition_strategy`,
 *     `chunking_rules`, `transform_override`, or similar field. The
 *     migration's column set matches this contract; the typed surface
 *     refuses to write them at compile time.
 *
 *   - Status transitions are guarded by WHERE clauses on the previous
 *     status. The command-layer state machine decides which transitions
 *     are valid; this module's setters reject zero-row UPDATEs by
 *     returning `false`, leaving the caller to surface "already cancelled"
 *     idempotently.
 *
 *   - Counters (`events_planned`, `events_replayed`, `events_failed`) are
 *     owned by the planner (P7-002) and executor (P7-003). This module
 *     does NOT expose a counter setter for P7-001; that lands when the
 *     executor does.
 *
 * @see db/migrations/20260512000011_create_replay_jobs.sql
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-001-replay-job-model-cli.md
 */
import type { Database } from "@polaris/shared-db";
import type { ColumnType, Kysely } from "kysely";

/**
 * Closed set of `replay_jobs.status` values, mirroring the
 * `replay_jobs_status_allowed` CHECK in the migration.
 *
 * State machine:
 *
 *   pending  --> planning (planner picks up the job)
 *   planning --> dry_run  (mode='dry_run')
 *   planning --> running  (mode='live')
 *   running  --> paused   (operator-issued)
 *   paused   --> running  (operator-issued, restores prior status)
 *   <any non-terminal> --> cancelled (operator-issued)
 *   dry_run / running --> completed | failed (executor-issued)
 *
 * `completed`, `failed`, and `cancelled` are terminal: the CLI rejects
 * further mutations on jobs in those states.
 */
export const REPLAY_JOB_STATUSES = [
  "pending",
  "planning",
  "dry_run",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ReplayJobStatus = (typeof REPLAY_JOB_STATUSES)[number];

/**
 * Closed set of `replay_jobs.target` values, mirroring the
 * `replay_jobs_target_allowed` CHECK in the migration.
 *
 *   - `analytics_raw`  ClickHouse projection rebuild (P7-005 owns the
 *                       executor; this CLI just records the request)
 *   - `destinations`   destination consumers (P7-004 owns the guardrails)
 *   - `processor`      a single processor (P7-003 owns version pinning)
 */
export const REPLAY_JOB_TARGETS = ["analytics_raw", "destinations", "processor"] as const;
export type ReplayJobTarget = (typeof REPLAY_JOB_TARGETS)[number];

/**
 * Closed set of `replay_jobs.mode` values, mirroring the
 * `replay_jobs_mode_allowed` CHECK in the migration.
 *
 *   - `dry_run` plans + counts only; no replay traffic is emitted.
 *   - `live`    actually re-emits events through the target subsystem.
 */
export const REPLAY_JOB_MODES = ["dry_run", "live"] as const;
export type ReplayJobMode = (typeof REPLAY_JOB_MODES)[number];

/**
 * Terminal status set. Jobs in these states are immutable from this
 * command surface; the CLI rejects cancel / pause / resume requests
 * against them with a UsageError.
 */
export const TERMINAL_REPLAY_JOB_STATUSES: readonly ReplayJobStatus[] = [
  "completed",
  "failed",
  "cancelled",
] as const;

export function isTerminalReplayStatus(status: ReplayJobStatus): boolean {
  return TERMINAL_REPLAY_JOB_STATUSES.includes(status);
}

/**
 * Typed mirror of the `replay_jobs` table. The optional event-name and
 * event-id scope columns admit NULL; counters are bigint on the database
 * side (CLI surface narrows them to `number` because Polaris v1 caps
 * realistic replay windows well below 2^53 events — see
 * `toRow` for the explicit narrowing).
 *
 * The `error_class` / `error_message` columns are stamped by the
 * executor when it marks a row `failed` (P7-003). The CHECK
 * `replay_jobs_error_only_when_failed` enforces the columns are NULL
 * unless `status='failed'`; the typed surface admits NULL accordingly.
 */
export interface ReplayJobsTable {
  replay_job_id: string;
  project_id: string;
  environment: string;
  event_name: ColumnType<string | null, string | null | undefined, string | null>;
  event_id: ColumnType<string | null, string | null | undefined, string | null>;
  window_from: ColumnType<Date, Date | string | undefined, Date | string>;
  window_to: ColumnType<Date, Date | string | undefined, Date | string>;
  target: ColumnType<ReplayJobTarget, ReplayJobTarget, ReplayJobTarget>;
  mode: ColumnType<ReplayJobMode, ReplayJobMode, ReplayJobMode>;
  status: ColumnType<ReplayJobStatus, ReplayJobStatus | undefined, ReplayJobStatus>;
  created_by: string;
  reason: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  planned_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  started_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  finished_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  events_planned: ColumnType<
    bigint | number | string,
    bigint | number | string | undefined,
    bigint | number | string
  >;
  events_replayed: ColumnType<
    bigint | number | string,
    bigint | number | string | undefined,
    bigint | number | string
  >;
  events_failed: ColumnType<
    bigint | number | string,
    bigint | number | string | undefined,
    bigint | number | string
  >;
  error_class: ColumnType<string | null, string | null | undefined, string | null>;
  error_message: ColumnType<string | null, string | null | undefined, string | null>;
}

declare module "@polaris/shared-db" {
  interface Database {
    replay_jobs: ReplayJobsTable;
  }
}

/**
 * Read-shape returned to the command layer. Plain JSON: timestamps stamped
 * as ISO strings so the `human` and `json` renderers see the same value.
 * Counters narrow to `number`; the migration stores them as bigint to
 * future-proof, but the executor capping is far below 2^53.
 */
export interface ReplayJobRow {
  readonly replay_job_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly event_name: string | null;
  readonly event_id: string | null;
  readonly window_from: string;
  readonly window_to: string;
  readonly target: ReplayJobTarget;
  readonly mode: ReplayJobMode;
  readonly status: ReplayJobStatus;
  readonly created_by: string;
  readonly reason: string;
  readonly created_at: string;
  readonly planned_at: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly events_planned: number;
  readonly events_replayed: number;
  readonly events_failed: number;
  /**
   * Error class persisted by the executor when it marks a row `failed`
   * (P7-003). `null` for any non-failed row.
   */
  readonly error_class: string | null;
  /**
   * Error message persisted by the executor when it marks a row
   * `failed` (P7-003). `null` for any non-failed row.
   */
  readonly error_message: string | null;
}

/**
 * Insert payload accepted by {@link insertReplayJob}. Caller has already
 * generated `replay_job_id`, validated the closed-set fields, and resolved
 * the actor label. The repository function below cannot accept planner
 * semantics (partition strategy, chunking rules, transform overrides)
 * because the parameter type does not carry them.
 */
export interface InsertReplayJobInput {
  readonly replay_job_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly event_name?: string | null;
  readonly event_id?: string | null;
  readonly window_from: Date;
  readonly window_to: Date;
  readonly target: ReplayJobTarget;
  readonly mode: ReplayJobMode;
  readonly created_by: string;
  readonly reason: string;
}

/**
 * INSERT a freshly-issued replay-job row. `status` defaults to
 * `'pending'` at the schema level and `created_at` to `now()`; we let the
 * server choose those so the row's creation time matches PostgreSQL's UTC
 * clock rather than the CLI host's clock.
 */
export async function insertReplayJob(
  db: Kysely<Database>,
  input: InsertReplayJobInput,
): Promise<void> {
  await db
    .insertInto("replay_jobs")
    .values({
      replay_job_id: input.replay_job_id,
      project_id: input.project_id,
      environment: input.environment,
      event_name: input.event_name ?? null,
      event_id: input.event_id ?? null,
      window_from: input.window_from,
      window_to: input.window_to,
      target: input.target,
      mode: input.mode,
      created_by: input.created_by,
      reason: input.reason,
    })
    .execute();
}

/**
 * Look up one row by its public id. Used by `show`, `cancel`, `pause`,
 * and `resume`. Returns `null` for an unknown id.
 */
export async function findReplayJobById(
  db: Kysely<Database>,
  replayJobId: string,
): Promise<ReplayJobRow | null> {
  const row = await db
    .selectFrom("replay_jobs")
    .selectAll()
    .where("replay_job_id", "=", replayJobId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * Filter accepted by `polaris replay list`. All fields optional and
 * combined with AND.
 */
export interface ListReplayJobsFilter {
  readonly status?: ReplayJobStatus;
  readonly projectId?: string;
  readonly environment?: string;
  readonly limit?: number;
}

/**
 * Return replay-job rows matching the supplied filter, ordered by
 * `created_at DESC`. Default limit is 50 (same as `audit list`).
 */
export async function listReplayJobs(
  db: Kysely<Database>,
  filter: ListReplayJobsFilter,
): Promise<ReplayJobRow[]> {
  let query = db.selectFrom("replay_jobs").selectAll();
  if (filter.status !== undefined) {
    query = query.where("status", "=", filter.status);
  }
  if (filter.projectId !== undefined) {
    query = query.where("project_id", "=", filter.projectId);
  }
  if (filter.environment !== undefined) {
    query = query.where("environment", "=", filter.environment);
  }
  const limit = filter.limit ?? 50;
  query = query.orderBy("created_at", "desc").limit(limit);
  const rows = await query.execute();
  return rows.map(toRow);
}

/**
 * Transition a replay job to `'cancelled'` and stamp `finished_at`. Only
 * affects rows whose current status is a non-terminal state — the WHERE
 * filter excludes `completed`, `failed`, and `cancelled` so the cancel
 * path is idempotent against terminal states.
 *
 * The caller validates the previous status against the documented matrix
 * (pending | planning | dry_run | running | paused). Passing in a row
 * whose status is already terminal returns `false`.
 */
export async function cancelReplayJob(
  db: Kysely<Database>,
  replayJobId: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("replay_jobs")
    .set({
      status: "cancelled",
      finished_at: now,
    })
    .where("replay_job_id", "=", replayJobId)
    .where("status", "not in", ["completed", "failed", "cancelled"])
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Transition a replay job to `'paused'`. Only affects rows whose current
 * status is one of the documented sources (pending | planning | running).
 * Returns whether a real transition happened.
 */
export async function pauseReplayJob(
  db: Kysely<Database>,
  replayJobId: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("replay_jobs")
    .set({
      status: "paused",
      // pause does not finish the job; finished_at stays NULL.
      // updated to no-op finished_at; we set planned_at on the planning->paused
      // path only when planning had stamped planned_at already, so we leave the
      // columns alone here.
    })
    .where("replay_job_id", "=", replayJobId)
    .where("status", "in", ["pending", "planning", "running"])
    .executeTakeFirst();
  // Reference `now` to keep callers consistent with the rest of the module;
  // pause does not stamp a timestamp column today but a future "paused_at"
  // addition (P7-003 ergonomics) would land here.
  void now;
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Transition a replay job out of `'paused'`. The target status is supplied
 * by the caller because pause is "freeze the current lifecycle stage" — a
 * job paused while `running` should resume into `running`, while one
 * paused while `planning` should resume into `planning`. The caller
 * captures the pre-pause status when issuing the pause; for v1 the CLI
 * always resumes to `'running'` since pre-pause was either `running` or
 * `planning` (and the planner-driven `planning->running` will happen
 * again under P7-002).
 */
export async function resumeReplayJob(
  db: Kysely<Database>,
  replayJobId: string,
  targetStatus: ReplayJobStatus,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("replay_jobs")
    .set({
      status: targetStatus,
    })
    .where("replay_job_id", "=", replayJobId)
    .where("status", "=", "paused")
    .executeTakeFirst();
  void now;
  return Number(result.numUpdatedRows ?? 0) > 0;
}

function toRow(row: {
  readonly replay_job_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly event_name: string | null;
  readonly event_id: string | null;
  readonly window_from: Date;
  readonly window_to: Date;
  readonly target: ReplayJobTarget;
  readonly mode: ReplayJobMode;
  readonly status: ReplayJobStatus;
  readonly created_by: string;
  readonly reason: string;
  readonly created_at: Date;
  readonly planned_at: Date | null;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly events_planned: bigint | number | string;
  readonly events_replayed: bigint | number | string;
  readonly events_failed: bigint | number | string;
  readonly error_class: string | null;
  readonly error_message: string | null;
}): ReplayJobRow {
  return {
    replay_job_id: row.replay_job_id,
    project_id: row.project_id,
    environment: row.environment,
    event_name: row.event_name,
    event_id: row.event_id,
    window_from: row.window_from.toISOString(),
    window_to: row.window_to.toISOString(),
    target: row.target,
    mode: row.mode,
    status: row.status,
    created_by: row.created_by,
    reason: row.reason,
    created_at: row.created_at.toISOString(),
    planned_at: row.planned_at === null ? null : row.planned_at.toISOString(),
    started_at: row.started_at === null ? null : row.started_at.toISOString(),
    finished_at: row.finished_at === null ? null : row.finished_at.toISOString(),
    events_planned: toCounter(row.events_planned),
    events_replayed: toCounter(row.events_replayed),
    events_failed: toCounter(row.events_failed),
    error_class: row.error_class,
    error_message: row.error_message,
  };
}

function toCounter(value: bigint | number | string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.parseInt(value, 10);
}

// ---------------------------------------------------------------------------
// Executor-owned setters (P7-003)
// ---------------------------------------------------------------------------

/**
 * Input accepted by {@link markReplayJobRunning}. The executor calls
 * this once when it picks up a row; the function transitions
 * `pending|planning` rows to `running` and stamps `started_at`.
 */
export interface MarkReplayJobRunningInput {
  readonly replay_job_id: string;
  readonly events_planned: number;
  readonly started_at: Date;
}

/**
 * Transition a `pending` or `planning` replay-job row to `running` and
 * stamp `started_at` + `events_planned`. Returns the row's post-update
 * status so the executor can detect a peer setter having flipped it to
 * `paused` or `cancelled` first.
 *
 * Returns `null` when the row no longer exists. The status field is
 * read from a follow-up SELECT so a no-op UPDATE (the row was already
 * in `running`/`paused`/`cancelled`) still surfaces the current state.
 */
export async function markReplayJobRunning(
  db: Kysely<Database>,
  input: MarkReplayJobRunningInput,
): Promise<ReplayJobRow | null> {
  await db
    .updateTable("replay_jobs")
    .set({
      status: "running",
      started_at: input.started_at,
      events_planned: input.events_planned,
    })
    .where("replay_job_id", "=", input.replay_job_id)
    .where("status", "in", ["pending", "planning"])
    .executeTakeFirst();
  return findReplayJobById(db, input.replay_job_id);
}

/**
 * Input accepted by {@link recordReplayChunkProgress}. The executor
 * calls this once per chunk to advance the planner counters.
 */
export interface RecordReplayChunkProgressInput {
  readonly replay_job_id: string;
  readonly cumulative_emitted: number;
  readonly cumulative_failed: number;
  readonly now: Date;
}

/**
 * Stamp cumulative emitted / failed counters on a `running` replay job.
 * The cumulative values are absolute — the caller passes the running
 * total across all completed chunks — so a re-execution of a chunk does
 * not double-count.
 *
 * Returns the row AFTER the update so the executor can see whether a
 * peer setter (cancel / pause) raced.
 */
export async function recordReplayChunkProgress(
  db: Kysely<Database>,
  input: RecordReplayChunkProgressInput,
): Promise<ReplayJobRow | null> {
  await db
    .updateTable("replay_jobs")
    .set({
      events_replayed: input.cumulative_emitted,
      events_failed: input.cumulative_failed,
    })
    .where("replay_job_id", "=", input.replay_job_id)
    .where("status", "=", "running")
    .executeTakeFirst();
  // The `now` arg is unused today but kept on the signature so a future
  // `last_progress_at` column can land without changing the public type.
  void input.now;
  return findReplayJobById(db, input.replay_job_id);
}

export interface CompleteReplayJobInput {
  readonly replay_job_id: string;
  readonly events_replayed: number;
  readonly events_failed: number;
  readonly finished_at: Date;
}

/**
 * Transition a `running` row to `completed` and stamp `finished_at`.
 * Returns whether the transition fired.
 */
export async function completeReplayJob(
  db: Kysely<Database>,
  input: CompleteReplayJobInput,
): Promise<boolean> {
  const result = await db
    .updateTable("replay_jobs")
    .set({
      status: "completed",
      finished_at: input.finished_at,
      events_replayed: input.events_replayed,
      events_failed: input.events_failed,
    })
    .where("replay_job_id", "=", input.replay_job_id)
    .where("status", "=", "running")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

export interface FailReplayJobInput {
  readonly replay_job_id: string;
  readonly events_replayed: number;
  readonly events_failed: number;
  readonly finished_at: Date;
  readonly error_class: string;
  readonly error_message: string;
}

/**
 * Transition a `running` row to `failed`, stamp `finished_at`, and
 * persist the error class + message. The CHECK
 * `replay_jobs_error_only_when_failed` keeps the schema consistent.
 * Returns whether the transition fired.
 */
export async function failReplayJob(
  db: Kysely<Database>,
  input: FailReplayJobInput,
): Promise<boolean> {
  const result = await db
    .updateTable("replay_jobs")
    .set({
      status: "failed",
      finished_at: input.finished_at,
      events_replayed: input.events_replayed,
      events_failed: input.events_failed,
      error_class: input.error_class,
      error_message: input.error_message,
    })
    .where("replay_job_id", "=", input.replay_job_id)
    .where("status", "=", "running")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}
