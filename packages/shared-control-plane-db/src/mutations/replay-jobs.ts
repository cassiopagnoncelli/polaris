/**
 * Audited replay-job mutations.
 *
 * ## The gap this closes
 *
 * `replay execute` wrote no audit row. It logged a line carrying
 * `audit_action: "replay.execute"` and left it there, on the reasoning that
 * the trail lives in `replay create` / `cancel` and that the executor's
 * lifecycle moves are derivable from the row's timestamps and counters.
 *
 * That holds for a CLI, where the operator who typed the command is the one
 * reading the logs. It does not hold generally: `replay_jobs.created_by`
 * records who *created* the job, not who *ran* it, and those are different
 * people whenever a job is planned by one operator and executed by another —
 * which is the entire point of having a plan step. Derivable-from-timestamps
 * tells you that it ran, never who started it.
 *
 * So the pending→running transition now carries an audit row, written in the
 * same transaction. It is the moment the decision becomes irreversible: past
 * it, real events are on a real topic.
 *
 * ## What the row records
 *
 * The snapshot names the blast radius, because that is what a reader of the
 * audit log actually wants to reconstruct: the resolved target topic,
 * whether that topic reaches vendor destinations, and whether the operator
 * acknowledged it. See `@polaris/shared-replay`'s `destinations.ts` for why
 * reachability is a property of the topic rather than of the declared target.
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

import type { AuditEnvironment } from "../queries/audit-records.js";
import {
  cancelReplayJob,
  type InsertReplayJobInput,
  insertReplayJob,
  markReplayJobRunning,
  pauseReplayJob,
  type ReplayJobRow,
  resumeReplayJob,
} from "../queries/replay-jobs.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

export interface ReplayAuditSnapshot {
  readonly replay_job_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly target: string;
  readonly mode: string;
  readonly status: string;
  readonly window_from: string;
  readonly window_to: string;
}

export function toReplaySnapshot(row: ReplayJobRow): ReplayAuditSnapshot {
  return {
    replay_job_id: row.replay_job_id,
    project_id: row.project_id,
    environment: row.environment,
    target: row.target,
    mode: row.mode,
    status: row.status,
    window_from: toIso(row.window_from),
    window_to: toIso(row.window_to),
  };
}

function replayTarget(row: ReplayJobRow, action: string) {
  return {
    action,
    targetType: "replay_job",
    targetId: row.replay_job_id,
    projectId: row.project_id,
    environment: row.environment as AuditEnvironment,
  };
}

/**
 * Record the decision to execute, and take the job to `running`.
 *
 * Returns `applied: false` when the row was not in a startable state — the
 * executor treats that as "someone else got here first" and refuses, and no
 * audit row is written because nothing transitioned.
 */
export async function startReplayExecutionWithAudit(
  db: Kysely<Database>,
  input: {
    row: ReplayJobRow;
    eventsPlanned: number;
    /** Topic the executor will publish to, after any `--target-topic` override. */
    targetTopic: string;
    /** Whether that topic feeds the destination consumers. */
    reachesDestinations: boolean;
    /** Whether the operator acknowledged external delivery on the plan. */
    destinationsAcknowledged: boolean;
  },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toReplaySnapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      ...replayTarget(input.row, "replay.execute"),
      before,
      after: {
        ...before,
        status: "running",
        events_planned: input.eventsPlanned,
        // The three facts a reader needs to reconstruct what this touched.
        target_topic: input.targetTopic,
        reaches_destinations: input.reachesDestinations,
        destinations_acknowledged: input.destinationsAcknowledged,
      },
    },
    async (trx) => {
      const transition = await markReplayJobRunning(trx, {
        replay_job_id: input.row.replay_job_id,
        events_planned: input.eventsPlanned,
        started_at: audit.occurredAt,
      });
      // markReplayJobRunning returns the post-update row (or null). Only a
      // real move to `running` counts as a transition worth recording.
      return transition !== null && transition.status === "running";
    },
  );
}

/**
 * Create a replay job.
 *
 * Creation is the operator declaring intent; nothing is republished until
 * `startReplayExecutionWithAudit`. The two are separate audit actions because
 * they are separately consequential, and often separate people.
 */
export async function createReplayJobWithAudit(
  db: Kysely<Database>,
  input: InsertReplayJobInput,
  audit: AuditContext,
): Promise<MutationOutcome> {
  return withAudit(
    db,
    audit,
    {
      action: "replay.create",
      targetType: "replay_job",
      targetId: input.replay_job_id,
      projectId: input.project_id,
      environment: input.environment as AuditEnvironment,
      before: null,
      after: {
        replay_job_id: input.replay_job_id,
        project_id: input.project_id,
        environment: input.environment,
        target: input.target,
        mode: input.mode,
        status: "pending",
        window_from: input.window_from.toISOString(),
        window_to: input.window_to.toISOString(),
        event_name: input.event_name ?? null,
        event_id: input.event_id ?? null,
      },
    },
    async (trx) => {
      await insertReplayJob(trx, input);
      return true;
    },
  );
}

export async function cancelReplayJobWithAudit(
  db: Kysely<Database>,
  input: { row: ReplayJobRow },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toReplaySnapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      ...replayTarget(input.row, "replay.cancel"),
      before,
      after: { ...before, status: "cancelled" },
    },
    (trx) => cancelReplayJob(trx, input.row.replay_job_id, audit.occurredAt),
  );
}

export async function pauseReplayJobWithAudit(
  db: Kysely<Database>,
  input: { row: ReplayJobRow },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toReplaySnapshot(input.row);
  return withAudit(
    db,
    audit,
    { ...replayTarget(input.row, "replay.pause"), before, after: { ...before, status: "paused" } },
    (trx) => pauseReplayJob(trx, input.row.replay_job_id, audit.occurredAt),
  );
}

export async function resumeReplayJobWithAudit(
  db: Kysely<Database>,
  input: { row: ReplayJobRow; targetStatus: "pending" | "running" },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toReplaySnapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      ...replayTarget(input.row, "replay.resume"),
      before,
      after: { ...before, status: input.targetStatus },
    },
    (trx) => resumeReplayJob(trx, input.row.replay_job_id, input.targetStatus, audit.occurredAt),
  );
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
