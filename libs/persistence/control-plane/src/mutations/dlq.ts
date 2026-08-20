/**
 * Audited DLQ resolution — the triage half of the two DLQ tables.
 *
 * ## Why these live here and not with the repositories
 *
 * `dlq_records` and `processor_dlq_records` each have two distinct users:
 *
 *   - the **runtime**, which records a new row when a delivery or a
 *     processor handler fails. That lives in `@polaris/delivery-destinations`
 *     and `@polaris/pipeline`, next to the code that fails.
 *   - the **operator**, who triages: lists, reads, retries, marks resolved.
 *     That is control-plane state, and it is what this file owns.
 *
 * Splitting on that line is what lets `apps/control-plane-api` resolve a DLQ
 * row without taking a dependency on the destination delivery stack — which
 * would drag `@polaris/bus` and therefore amqplib into a service
 * that deliberately speaks to no broker, for the sake of one triage toggle.
 *
 * ## On having two UPDATEs against the same column
 *
 * The runtime repositories keep their own `markResolved`. Theirs does a
 * read-modify-write and returns the full record, because the delivery path
 * wants it; this one is the guarded UPDATE every other mutation in this
 * package uses, and lets `withAudit` decide `applied` from whether a row
 * matched. Both are guarded on `resolved_at IS NULL`, so both are idempotent
 * and neither can resolve a row twice — `resolvedGuardIsIdempotent` in the
 * test suite pins that. The alternative was moving 600-odd lines of
 * delivery-critical repository code to save fifteen, which is not a trade
 * worth making.
 */

import type { Database } from "@polaris/persistence-postgres";
import { type Kysely, sql } from "kysely";

import type { AuditEnvironment } from "../queries/audit-records.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

/** Matches `dlq_records_resolution_note_length` / its processor twin. */
export const DLQ_RESOLUTION_NOTE_MAX_LENGTH = 1024;

/** Identity of the row being resolved, as the audit snapshot records it. */
export interface DlqResolutionTarget {
  readonly dlqId: string;
  readonly projectId: string;
  readonly environment: string;
  /** `vendor` for a destination row, `processor_name` for a processor one. */
  readonly owner: string;
  readonly reason: string;
}

function clampNote(note: string | null): string | null {
  if (note === null) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, DLQ_RESOLUTION_NOTE_MAX_LENGTH);
}

async function resolve(
  db: Kysely<Database>,
  table: "dlq_records" | "processor_dlq_records",
  target: DlqResolutionTarget,
  input: { resolvedBy: string; note: string | null },
  audit: AuditContext,
  spec: { action: string; targetType: string; ownerKey: string },
): Promise<MutationOutcome> {
  const note = clampNote(input.note);
  const before = {
    dlq_id: target.dlqId,
    project_id: target.projectId,
    environment: target.environment,
    [spec.ownerKey]: target.owner,
    reason: target.reason,
    resolved_at: null,
  };

  return withAudit(
    db,
    audit,
    {
      action: spec.action,
      targetType: spec.targetType,
      targetId: target.dlqId,
      projectId: target.projectId,
      environment: target.environment as AuditEnvironment,
      before,
      after: {
        ...before,
        resolved_at: audit.occurredAt.toISOString(),
        resolved_by: input.resolvedBy,
        resolution_note: note,
      },
    },
    async (trx) => {
      // `resolved_at IS NULL` is the guard: a second resolve matches nothing,
      // reports applied=false, and writes no audit row. Triage is idempotent
      // by design — two operators closing the same row is not two events.
      const result = await sql<{ dlq_id: string }>`
        UPDATE ${sql.raw(table)}
        SET resolved_at = ${audit.occurredAt},
            resolved_by = ${input.resolvedBy},
            resolution_note = ${note}
        WHERE dlq_id = ${target.dlqId}
          AND resolved_at IS NULL
        RETURNING dlq_id
      `.execute(trx);
      return result.rows.length > 0;
    },
  );
}

/** Resolve a destination-DLQ row. Idempotent. */
export async function markDlqResolvedWithAudit(
  db: Kysely<Database>,
  target: DlqResolutionTarget,
  input: { resolvedBy: string; note: string | null },
  audit: AuditContext,
): Promise<MutationOutcome> {
  return resolve(db, "dlq_records", target, input, audit, {
    action: "dlq.mark_resolved",
    targetType: "dlq_record",
    ownerKey: "vendor",
  });
}

/** Resolve a processor-DLQ row. Idempotent. */
export async function markProcessorDlqResolvedWithAudit(
  db: Kysely<Database>,
  target: DlqResolutionTarget,
  input: { resolvedBy: string; note: string | null },
  audit: AuditContext,
): Promise<MutationOutcome> {
  return resolve(db, "processor_dlq_records", target, input, audit, {
    action: "processors.dlq.mark_resolved",
    targetType: "processor_dlq_record",
    ownerKey: "processor_name",
  });
}

/**
 * Record that a processor-DLQ row was republished, and resolve it.
 *
 * The republish itself happens outside this transaction — it is a RabbitMQ
 * publish, and there is no way to make a broker publish and a Postgres commit
 * atomic. The order is deliberate: publish first, then resolve. A crash
 * between them leaves the row unresolved and the message redelivered, which
 * an operator can see and re-triage. The reverse would lose the row silently.
 */
export async function markProcessorDlqRetriedWithAudit(
  db: Kysely<Database>,
  target: DlqResolutionTarget,
  input: { resolvedBy: string; note: string | null; redeliverQueue: string },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const note = clampNote(input.note);
  const before = {
    dlq_id: target.dlqId,
    project_id: target.projectId,
    environment: target.environment,
    processor_name: target.owner,
    reason: target.reason,
    resolved_at: null,
  };

  return withAudit(
    db,
    audit,
    {
      action: "processors.dlq.retry",
      targetType: "processor_dlq_record",
      targetId: target.dlqId,
      projectId: target.projectId,
      environment: target.environment as AuditEnvironment,
      before,
      after: {
        ...before,
        resolved_at: audit.occurredAt.toISOString(),
        resolved_by: input.resolvedBy,
        resolution_note: note,
        // Which queue the stored envelope went back onto, so the audit row
        // explains where the traffic came from if it fails again.
        redelivered_to: input.redeliverQueue,
      },
    },
    async (trx) => {
      const result = await sql<{ dlq_id: string }>`
        UPDATE processor_dlq_records
        SET resolved_at = ${audit.occurredAt},
            resolved_by = ${input.resolvedBy},
            resolution_note = ${note}
        WHERE dlq_id = ${target.dlqId}
          AND resolved_at IS NULL
        RETURNING dlq_id
      `.execute(trx);
      return result.rows.length > 0;
    },
  );
}
