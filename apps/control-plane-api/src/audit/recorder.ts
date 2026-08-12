/**
 * Audit recorder for the control-plane API.
 *
 * Every mutating request writes one row to `audit_records` after the
 * handler completes (success or failure). The shape mirrors the CLI
 * recorder (`apps/polaris-cli/src/audit/recorder.ts`) so the same
 * downstream `polaris audit list/export` commands surface every
 * mutation regardless of the entry point.
 *
 * `actor_id` (`audit_records.actor_label`), `actor_source`,
 * `actor_display` (label), the `mutates` flag, the route command id,
 * and an optional `denied_reason` flow into the row. Plaintext tokens
 * and secret-resolved values NEVER appear in any column — the schema
 * forbids the columns and tests assert the surface.
 */

import type { ResolvedActor } from "@polaris/shared-control-plane";
import type { AuditRecordsTable } from "@polaris/shared-control-plane-db";
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

/**
 * Typed mirror of the `audit_records` table. Duplicated from
 * `apps/polaris-cli/src/db/audit-records.ts` for the same reason the
 * table shape and its `declare module` augmentation now live in
 * `@polaris/shared-control-plane-db`, which owns them for both this service
 * and the CLI. They used to be declared here AND in the CLI: module
 * augmentation is additive, so TypeScript merged the two copies silently —
 * right up until someone edited one of them.
 */
export type { AuditRecordsTable };

/**
 * Closed set of audit `actor_source` values, mirroring the
 * `audit_records_actor_source_allowed` CHECK constraint in the
 * migration. Kept narrow on purpose so a typo at the call site fails
 * type-check.
 */
export const AUDIT_ACTOR_SOURCES = [
  "declared",
  "operator_token",
  "cli",
  "migration",
  "system",
] as const;
export type AuditActorSource = (typeof AUDIT_ACTOR_SOURCES)[number];

export const AUDIT_ENVIRONMENTS = ["development", "staging", "production"] as const;
export type AuditEnvironment = (typeof AUDIT_ENVIRONMENTS)[number];

/**
 * Input accepted by `recordControlPlaneAudit`. The hook computes
 * `auditId` (UUIDv7), reads `actor` off the request, and lets the
 * caller pass the route id + denial reason + before/after snapshots.
 */
export interface RecordAuditInput {
  readonly auditId?: string;
  readonly actor: ResolvedActor;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly projectId?: string | null;
  readonly environment?: AuditEnvironment | null;
  readonly before?: unknown | null;
  readonly after?: unknown | null;
  readonly reason?: string | null;
  readonly requestId: string;
  readonly occurredAt?: Date;
}

/** Audit recorder surface used by the API route lifecycle hook. */
export interface AuditRecorder {
  record(input: RecordAuditInput): Promise<void>;
}

/**
 * Build a Kysely-backed audit recorder. The CLI ships an equivalent
 * recorder in `apps/polaris-cli/src/db/audit-records.ts`; the
 * production rule is "exactly one audit_records row per mutation",
 * regardless of entry point.
 */
export function createKyselyAuditRecorder(db: Kysely<Database>): AuditRecorder {
  return {
    async record(input: RecordAuditInput): Promise<void> {
      const auditId = input.auditId ?? `polaris_aud_${uuidv7()}`;
      const occurredAt = input.occurredAt ?? new Date();
      const actorSource: AuditActorSource = input.actor.source;
      const values: {
        audit_id: string;
        actor_source: AuditActorSource;
        actor_label: string;
        action: string;
        target_type: string;
        target_id: string;
        project_id: string | null;
        environment: AuditEnvironment | null;
        before: unknown | null;
        after: unknown | null;
        reason: string | null;
        request_id: string | null;
        created_at?: Date;
      } = {
        audit_id: auditId,
        actor_source: actorSource,
        actor_label: input.actor.label,
        action: input.action,
        target_type: input.targetType,
        target_id: input.targetId,
        project_id: input.projectId ?? null,
        environment: input.environment ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        reason: input.reason ?? null,
        request_id: input.requestId,
        created_at: occurredAt,
      };
      await db.insertInto("audit_records").values(values).execute();
    },
  };
}

/**
 * In-memory recorder for tests. Records every call so the test can
 * assert against the input. The `records` array is the source of
 * truth in tests; clearing it between runs is the test's job.
 */
export class InMemoryAuditRecorder implements AuditRecorder {
  public readonly records: RecordAuditInput[] = [];

  async record(input: RecordAuditInput): Promise<void> {
    this.records.push({ ...input });
  }
}
