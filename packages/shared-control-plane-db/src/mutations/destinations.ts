/**
 * Audited destination mutations.
 *
 * The `action` strings match what the CLI already writes
 * (`destinations.enable` / `destinations.disable`) so
 * `polaris audit list --action destinations.disable` returns CLI-originated
 * and UI-originated rows in one stream, distinguished by `actor_label`
 * rather than by needing a second column.
 *
 * `toDestinationSnapshot` is the before/after shape the CLI records. It is
 * shared rather than re-derived so a reader diffing two audit rows sees the
 * same fields regardless of which surface wrote them — and so the snapshot
 * keeps carrying `secret_ref` (a `<provider>:<ref>` pointer) and never a
 * resolved secret.
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

import type { AuditEnvironment } from "../queries/audit-records.js";
import {
  type DestinationRow,
  disableDestination,
  disableDestinationReplay,
  enableDestination,
  enableDestinationReplay,
  findDestinationById,
  type InsertDestinationInput,
  insertDestination,
  type UpdateDestinationOpsInput,
  updateDestinationOps,
} from "../queries/destinations.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

export interface DestinationAuditSnapshot {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly status: string;
  readonly mode: string;
  readonly disabled_reason: string | null;
}

export function toDestinationSnapshot(row: DestinationRow): DestinationAuditSnapshot {
  return {
    destination_id: row.destination_id,
    project_id: row.project_id,
    environment: row.environment,
    vendor: row.vendor,
    instance_label: row.instance_label,
    status: row.status,
    mode: row.mode,
    disabled_reason: row.disabled_reason,
  };
}

/**
 * Disable a destination.
 *
 * Idempotent: disabling an already-disabled destination reports
 * `applied: false` and writes no audit row.
 */
export async function disableDestinationWithAudit(
  db: Kysely<Database>,
  input: { row: DestinationRow; reason: string },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toDestinationSnapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      action: "destinations.disable",
      targetType: "destination",
      targetId: input.row.destination_id,
      projectId: input.row.project_id,
      environment: input.row.environment as AuditEnvironment,
      before,
      after: { ...before, status: "disabled", disabled_reason: input.reason },
    },
    (trx) => disableDestination(trx, input.row.destination_id, input.reason, audit.occurredAt),
  );
}

/**
 * Enable a destination.
 *
 * Idempotent: enabling an already-active destination reports
 * `applied: false` and writes no audit row.
 */
export async function enableDestinationWithAudit(
  db: Kysely<Database>,
  input: { row: DestinationRow },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toDestinationSnapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      action: "destinations.enable",
      targetType: "destination",
      targetId: input.row.destination_id,
      projectId: input.row.project_id,
      environment: input.row.environment as AuditEnvironment,
      before,
      // `enableDestination` clears `disabled_reason` alongside the status, so
      // the snapshot has to as well or the audit trail claims a reason
      // survived that did not.
      after: { ...before, status: "active", disabled_reason: null },
    },
    (trx) => enableDestination(trx, input.row.destination_id, audit.occurredAt),
  );
}

/**
 * Create a destination.
 *
 * Creation is the one destination mutation with no `before` — there was no
 * row. The snapshot is the row as it will exist, and `secret_ref` rides along
 * as the `<provider>:<ref>` pointer it is; the resolved secret never touches
 * this package.
 */
export async function createDestinationWithAudit(
  db: Kysely<Database>,
  input: InsertDestinationInput,
  audit: AuditContext,
): Promise<MutationOutcome> {
  return withAudit(
    db,
    audit,
    {
      action: "destinations.create",
      targetType: "destination",
      targetId: input.destination_id,
      projectId: input.project_id,
      environment: input.environment as AuditEnvironment,
      before: null,
      after: {
        destination_id: input.destination_id,
        project_id: input.project_id,
        environment: input.environment,
        vendor: input.vendor,
        instance_label: input.instance_label,
        secret_ref: input.secret_ref,
        mode: input.mode,
      },
    },
    async (trx) => {
      await insertDestination(trx, input);
      return true;
    },
  );
}

/**
 * Update the operational tuning knobs.
 *
 * The patch type is a strict allowlist of four numbers and a policy enum, so
 * there is no path through here that can write mapping or routing data into
 * Postgres — that stays in code, per the architecture's file-heavy rule.
 */
export async function updateDestinationOpsWithAudit(
  db: Kysely<Database>,
  input: { row: DestinationRow; patch: UpdateDestinationOpsInput },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toDestinationSnapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      action: "destinations.update-ops",
      targetType: "destination",
      targetId: input.row.destination_id,
      projectId: input.row.project_id,
      environment: input.row.environment as AuditEnvironment,
      before: {
        ...before,
        max_concurrency: input.row.max_concurrency,
        max_rps: input.row.max_rps,
        retry_policy: input.row.retry_policy,
        dead_letter_threshold: input.row.dead_letter_threshold,
      },
      after: { ...before, ...input.patch },
    },
    (trx) => updateDestinationOps(trx, input.row.destination_id, input.patch, audit.occurredAt),
  );
}

/**
 * Flip replay opt-in for one destination.
 *
 * This is the per-instance half of the P7-004 guardrail: replayed events
 * carry the `polaris-replay` header and are suppressed at the consumer unless
 * BOTH the host opted in and this column is true. Turning it on is therefore
 * a decision to let replayed traffic reach a real vendor, which is why the
 * reason is not optional.
 */
export async function setDestinationReplayOptInWithAudit(
  db: Kysely<Database>,
  input: { row: DestinationRow; enabled: boolean; reason: string },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = {
    ...toDestinationSnapshot(input.row),
    replay_opt_in: input.row.replay_opt_in,
    replay_opt_in_reason: input.row.replay_opt_in_reason,
  };
  return withAudit(
    db,
    audit,
    {
      action: input.enabled ? "destinations.enable-replay" : "destinations.disable-replay",
      targetType: "destination",
      targetId: input.row.destination_id,
      projectId: input.row.project_id,
      environment: input.row.environment as AuditEnvironment,
      before,
      after: { ...before, replay_opt_in: input.enabled, replay_opt_in_reason: input.reason },
    },
    (trx) =>
      input.enabled
        ? enableDestinationReplay(trx, input.row.destination_id, input.reason, audit.occurredAt)
        : disableDestinationReplay(trx, input.row.destination_id, input.reason, audit.occurredAt),
  );
}

/** Re-exported so callers can fetch the row the mutations above need. */
export { findDestinationById };
