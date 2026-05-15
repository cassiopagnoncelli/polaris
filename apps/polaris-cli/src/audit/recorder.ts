/**
 * Audit recorder.
 *
 * Central write surface for `audit_records` (created by P6-006's migration).
 * Every CLI mutation (P6-003 keys, P6-004 destinations, P6-005 processors,
 * future P6-007 operator tokens, P7 replays, P9 destinations) calls
 * `recordAudit({...})` after its DB write so the audit row is persisted
 * alongside the mutation.
 *
 * Cross-cut contract:
 *
 *   - Recorder calls go INSIDE the same Kysely transaction as the mutation
 *     when the caller can wrap the pair. For commands that perform a single
 *     UPDATE (`destinations.enable`, `destinations.disable`,
 *     `processors.enable`, `processors.disable`), the writer wraps the
 *     UPDATE + recorder call in `db.transaction().execute(async (trx) => ...)`.
 *     The recorder itself accepts a `Kysely<Database>` parameter so a
 *     transaction handle and the pool root use the same surface.
 *
 *   - The recorder never sees plaintext secrets. Callers pass
 *     `secret_ref` strings (`provider:ref` form) — those are safe to
 *     persist; only the resolved value is sensitive, and the recorder is
 *     never on the resolution path.
 *
 *   - Audit ids are UUIDv7 generated here unless an explicit id is passed
 *     by the test. UUIDv7 keeps audit rows ordered by creation time for
 *     index scans on the (target_type, target_id, created_at DESC)
 *     compound index in the migration.
 *
 *   - Actor identity defaults: v1 always writes `actor_source: 'cli'` and
 *     `actor_label: 'cli'`. After P6-007 (operator tokens), the dispatcher
 *     resolves a real actor and threads `actor_source: 'cli'` /
 *     `actor_label: 'cli:<email>'` through the recorder. The recorder
 *     refuses an empty label so a misconfigured caller cannot stamp
 *     anonymous rows.
 *
 * Anchored to:
 *   - docs/architecture/02-control-plane.md
 *       "Operator Identity and Audit Actor"
 *   - db/migrations/20260512000007_create_audit_records.sql
 *   - docs/implementation/tasks/P6-006-audit-export-cli.md
 */
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

import {
  AUDIT_ACTOR_SOURCES,
  AUDIT_ENVIRONMENTS,
  type AuditActorSource,
  type AuditEnvironment,
  type AuditRecordRow,
  findAuditRecordById,
  insertAuditRecord,
} from "../db/audit-records.js";

/**
 * Input accepted by `recordAudit(...)`.
 *
 * All snake_case columns from the migration get camelCase keys here so
 * existing callers (which speak camelCase in TypeScript) don't need
 * key-conversion logic.
 */
export interface RecordAuditInput {
  /** Closed set: `declared` | `cli` | `migration` | `system`. Default: `cli`. */
  readonly actorSource?: AuditActorSource;
  /** Free-form actor label. Required; cannot be empty. */
  readonly actorLabel: string;
  /** The action verb, e.g. `destinations.enable`, `keys.revoke`. */
  readonly action: string;
  /** The target noun, e.g. `destination`, `api_key`. */
  readonly targetType: string;
  /** The canonical id of the row the action touched. */
  readonly targetId: string;
  /** Project the target belongs to, when project-scoped. */
  readonly projectId?: string | null;
  /** Environment, when applicable. Closed set mirrors the migration's CHECK. */
  readonly environment?: AuditEnvironment | null;
  /** Pre-mutation operational state snapshot, or null for creates. */
  readonly before?: unknown | null;
  /** Post-mutation operational state snapshot, or null for hard deletes. */
  readonly after?: unknown | null;
  /** Operator-supplied rationale. */
  readonly reason?: string | null;
  /** CLI invocation correlation id (defaults to the new audit_id). */
  readonly requestId?: string | null;
  /** Explicit creation time (tests inject; production passes undefined). */
  readonly occurredAt?: Date;
}

/**
 * Recorder signature consumed by every mutation command. Production wires
 * this to `insertAuditRecord` over a Kysely client (or a transaction
 * handle); tests inject a stub that records calls.
 *
 * Returns the persisted audit_id so the caller can correlate it with its
 * own log line.
 */
export type AuditRecorder = (input: RecordAuditInput) => Promise<string>;

/**
 * Build a recorder bound to a Kysely client (or transaction).
 *
 * Pass the transaction handle when the caller wraps the mutation +
 * recorder call in `db.transaction().execute(...)`. Pass the pool root
 * when the caller does not need a transaction (e.g. an idempotent
 * detection path that bails before any UPDATE — in which case the audit
 * write usually doesn't happen at all).
 */
export function createAuditRecorder(
  db: Kysely<Database>,
  options: CreateRecorderOptions = {},
): AuditRecorder {
  const generateId = options.generateId ?? uuidv7;
  const now = options.now ?? (() => new Date());

  return async function recordAudit(input: RecordAuditInput): Promise<string> {
    const auditId = generateId();
    const occurredAt = input.occurredAt ?? now();
    validate(input);

    await insertAuditRecord(db, {
      audit_id: auditId,
      actor_source: input.actorSource ?? "cli",
      actor_label: input.actorLabel,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId,
      project_id: input.projectId ?? null,
      environment: input.environment ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.reason ?? null,
      request_id: input.requestId ?? auditId,
      created_at: occurredAt,
    });
    return auditId;
  };
}

export interface CreateRecorderOptions {
  /** Test override for the UUIDv7 generator. Defaults to `uuid.v7()`. */
  readonly generateId?: () => string;
  /** Test override for `new Date()`. */
  readonly now?: () => Date;
}

/**
 * Defensive input validation. The migration's CHECK constraints will
 * reject malformed rows, but failing them produces a noisy SQL error;
 * pre-validating here gives the caller a typed `UsageError`-style
 * exception with a clearer message.
 *
 * `recordAudit` is internal to the CLI so a plain `Error` is enough; the
 * dispatcher converts it to exit code 1. We do NOT throw a `UsageError`
 * because that would imply operator-correctable misuse — a recorder
 * validation failure is a programming bug, not a usage error.
 */
function validate(input: RecordAuditInput): void {
  if (input.actorSource !== undefined && !AUDIT_ACTOR_SOURCES.includes(input.actorSource)) {
    throw new Error(
      `recordAudit: actorSource must be one of ${AUDIT_ACTOR_SOURCES.join(", ")} (got "${input.actorSource}")`,
    );
  }
  const label = input.actorLabel.trim();
  if (label.length === 0) {
    throw new Error("recordAudit: actorLabel is required and must be non-empty");
  }
  if (label.length > 256) {
    throw new Error(
      `recordAudit: actorLabel must be 256 characters or fewer (got ${label.length})`,
    );
  }
  if (input.action.trim().length === 0 || input.action.length > 128) {
    throw new Error(
      `recordAudit: action must be 1-128 characters (got ${input.action.length} chars)`,
    );
  }
  if (input.targetType.trim().length === 0 || input.targetType.length > 64) {
    throw new Error(
      `recordAudit: targetType must be 1-64 characters (got ${input.targetType.length} chars)`,
    );
  }
  if (input.targetId.trim().length === 0 || input.targetId.length > 256) {
    throw new Error(
      `recordAudit: targetId must be 1-256 characters (got ${input.targetId.length} chars)`,
    );
  }
  if (
    input.environment !== undefined &&
    input.environment !== null &&
    !AUDIT_ENVIRONMENTS.includes(input.environment)
  ) {
    throw new Error(
      `recordAudit: environment must be one of ${AUDIT_ENVIRONMENTS.join(", ")} or null (got "${input.environment}")`,
    );
  }
  if (input.reason !== undefined && input.reason !== null && input.reason.length > 1024) {
    throw new Error(
      `recordAudit: reason must be 1024 characters or fewer (got ${input.reason.length})`,
    );
  }
}

/**
 * Re-export the audit record types so commands and tests don't reach into
 * the db module directly.
 */
export type { AuditRecordRow };

/**
 * Convenience: round-trip the most recently inserted audit row by id.
 * Used by the integration test in `apps/polaris-cli/test/audit-recorder.test.ts`.
 */
export async function readAuditRecord(
  db: Kysely<Database>,
  auditId: string,
): Promise<AuditRecordRow | null> {
  return findAuditRecordById(db, auditId);
}
