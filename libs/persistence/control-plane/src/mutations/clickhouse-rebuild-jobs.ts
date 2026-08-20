/**
 * Audited ClickHouse-rebuild-job mutations.
 *
 * This is the only command in Polaris that mutates ClickHouse data rather
 * than Postgres control state: a non-dry-run rebuild issues a real
 * `INSERT … SELECT argMax(...)` into a projection table. The Postgres row is
 * the operator-visible record of that, and the audit row is who asked for it.
 *
 * `clickhouse-rebuild.execute` is a separate action from `.create` because
 * the two are separately consequential — a job can be created and never run,
 * and the run is the part with side effects outside Postgres.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

import {
  abortClickhouseRebuildJob,
  type ClickhouseRebuildJobRow,
  type InsertClickhouseRebuildJobInput,
  insertClickhouseRebuildJob,
  markClickhouseRebuildJobRunning,
} from "../queries/clickhouse-rebuild-jobs.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

function snapshot(row: ClickhouseRebuildJobRow) {
  return {
    clickhouse_rebuild_job_id: row.clickhouse_rebuild_job_id,
    target_projection: row.target_projection,
    target_table_qualified: row.target_table_qualified,
    status: row.status,
  };
}

export async function createClickhouseRebuildJobWithAudit(
  db: Kysely<Database>,
  input: InsertClickhouseRebuildJobInput,
  audit: AuditContext,
): Promise<MutationOutcome> {
  return withAudit(
    db,
    audit,
    {
      action: "clickhouse-rebuild.create",
      targetType: "clickhouse_rebuild_job",
      targetId: input.clickhouse_rebuild_job_id,
      // Rebuild jobs target a projection table, which spans every project.
      before: null,
      after: {
        clickhouse_rebuild_job_id: input.clickhouse_rebuild_job_id,
        target_projection: input.target_projection,
        target_table_qualified: input.target_table_qualified,
        status: input.status ?? "pending",
        rows_estimated: input.rows_estimated ?? null,
      },
    },
    async (trx) => {
      await insertClickhouseRebuildJob(trx, input);
      return true;
    },
  );
}

/**
 * Record the decision to run a rebuild, and take the job to `running`.
 *
 * Same shape as `startReplayExecutionWithAudit` and for the same reason: past
 * this transition the job has written to ClickHouse, and the audit row is the
 * only record of who started it.
 */
export async function startClickhouseRebuildWithAudit(
  db: Kysely<Database>,
  input: { row: ClickhouseRebuildJobRow },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = snapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      action: "clickhouse-rebuild.execute",
      targetType: "clickhouse_rebuild_job",
      targetId: input.row.clickhouse_rebuild_job_id,
      before,
      after: { ...before, status: "running" },
    },
    async (trx) => {
      const transition = await markClickhouseRebuildJobRunning(
        trx,
        input.row.clickhouse_rebuild_job_id,
        audit.occurredAt,
      );
      // Null means the row vanished; any other status means a peer moved it
      // first (aborted, most likely). Only a real move to `running` is a
      // transition worth recording.
      return transition !== null && transition.status === "running";
    },
  );
}

/** Abort a rebuild. Idempotent on terminal states. */
export async function abortClickhouseRebuildJobWithAudit(
  db: Kysely<Database>,
  input: { row: ClickhouseRebuildJobRow },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = snapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      action: "clickhouse-rebuild.abort",
      targetType: "clickhouse_rebuild_job",
      targetId: input.row.clickhouse_rebuild_job_id,
      before,
      after: { ...before, status: "aborted" },
    },
    (trx) => abortClickhouseRebuildJob(trx, input.row.clickhouse_rebuild_job_id, audit.occurredAt),
  );
}
