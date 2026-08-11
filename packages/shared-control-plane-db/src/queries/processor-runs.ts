/**
 * Read helpers for the `processor_runs` table.
 *
 * A row records one processor process: which version started, where, when,
 * and how it ended. Writes belong to the processors themselves through
 * `@polaris/shared-processor`'s `openProcessorRun` — the control plane reads
 * runs, it never creates them, which is the whole distinction between this
 * table and `processor_activations`:
 *
 *   - `processor_activations` — what an operator switched on. Intent.
 *   - `processor_runs`        — what actually ran. Reality.
 *
 * The two join on `(processor_name, processor_version)`. They deliberately do
 * NOT join on `(project_id, environment)`: processors consume every project's
 * events off the shared stream and register cross-project runs with a null
 * `project_id`.
 *
 * @see db/migrations/20260512000008_create_processor_runs.sql
 * @see packages/shared-processor/src/run-lifecycle.ts
 */
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

/**
 * Read-shape returned to the command layer. Plain JSON, no Date — timestamps
 * are stamped as ISO strings so JSON output matches the human form.
 *
 * `project_id` and `environment` are nullable because a cross-project or
 * unscoped run leaves them unset; see the module header.
 */
export interface ProcessorRunRow {
  readonly run_id: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string | null;
  readonly environment: string | null;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly events_consumed: number;
  readonly events_emitted: number;
  readonly events_failed: number;
  readonly host: string | null;
  readonly error_summary: string | null;
}

/** Optional filters. Every field narrows; omitting all returns everything. */
export interface ProcessorRunScope {
  readonly project_id?: string | undefined;
  readonly environment?: string | undefined;
  readonly processor_name?: string | undefined;
  readonly processor_version?: string | undefined;
}

const COLUMNS = [
  "run_id",
  "processor_name",
  "processor_version",
  "project_id",
  "environment",
  "status",
  "started_at",
  "finished_at",
  "events_consumed",
  "events_emitted",
  "events_failed",
  "host",
  "error_summary",
] as const;

/**
 * List runs, newest first.
 *
 * `running` rows are not filtered out or sorted specially: a run that started
 * days ago and never closed is exactly what an operator is looking for.
 */
export async function listProcessorRuns(
  db: Kysely<Database>,
  scope: ProcessorRunScope = {},
  limit = 50,
): Promise<readonly ProcessorRunRow[]> {
  let query = db.selectFrom("processor_runs").select(COLUMNS);
  if (scope.project_id !== undefined) query = query.where("project_id", "=", scope.project_id);
  if (scope.environment !== undefined) query = query.where("environment", "=", scope.environment);
  if (scope.processor_name !== undefined) {
    query = query.where("processor_name", "=", scope.processor_name);
  }
  if (scope.processor_version !== undefined) {
    query = query.where("processor_version", "=", scope.processor_version);
  }
  const rows = await query.orderBy("started_at", "desc").limit(limit).execute();
  return rows.map(toRow);
}

/** Find one run by id. `null` when unknown. */
export async function findProcessorRunById(
  db: Kysely<Database>,
  runId: string,
): Promise<ProcessorRunRow | null> {
  const row = await db
    .selectFrom("processor_runs")
    .select(COLUMNS)
    .where("run_id", "=", runId)
    .executeTakeFirst();
  return row === undefined ? null : toRow(row);
}

/** Kysely hands back `Date`; the command layer renders ISO strings. */
function toRow(row: {
  run_id: string;
  processor_name: string;
  processor_version: string;
  project_id: string | null;
  environment: string | null;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  events_consumed: number;
  events_emitted: number;
  events_failed: number;
  host: string | null;
  error_summary: string | null;
}): ProcessorRunRow {
  return {
    run_id: row.run_id,
    processor_name: row.processor_name,
    processor_version: row.processor_version,
    project_id: row.project_id,
    environment: row.environment,
    status: row.status,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at === null ? null : row.finished_at.toISOString(),
    events_consumed: row.events_consumed,
    events_emitted: row.events_emitted,
    events_failed: row.events_failed,
    host: row.host,
    error_summary: row.error_summary,
  };
}
