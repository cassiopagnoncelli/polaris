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
  enableDestination,
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
