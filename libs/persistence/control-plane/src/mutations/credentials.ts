/**
 * Audited credential mutations: API keys and operator tokens.
 *
 * ## Why issuance lives here despite returning a secret
 *
 * These functions take an **already-hashed** credential. Generating the key
 * material and hashing it stays with the caller, because that is where the
 * plaintext has to be handed to a human and then forgotten. What this package
 * owns is the row and its audit record — so `insertApiKey` and
 * `insertOperatorToken` need no unaudited escape hatch, and the plaintext
 * never enters this file's scope at all.
 *
 * `hash` is never in a snapshot. Audit rows record what changed about a
 * credential, never the credential.
 *
 * ## Rotation is two rows, not one
 *
 * `keys rotate` issues a replacement and revokes the original in one
 * transaction, and writes **two** audit rows — `keys.rotate.issue` and
 * `keys.rotate.revoke` — matching what the CLI already did. One row would
 * force a reader to know that a rotation implies a revocation; two make both
 * halves greppable on their own, and the shared `audit_id` prefix ties them
 * together.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

import {
  type ApiKeyRow,
  findApiKeyById,
  type InsertApiKeyInput,
  insertApiKey,
  revokeApiKey,
} from "../queries/api-keys.js";
import type { AuditEnvironment } from "../queries/audit-records.js";
import { insertAuditRecord } from "../queries/audit-records.js";
import {
  type InsertOperatorTokenInput,
  insertOperatorToken,
  type OperatorTokenRow,
  revokeOperatorToken,
} from "../queries/operator-tokens.js";
import { type ApiKeyAuditSnapshot, toApiKeySnapshot } from "./api-keys.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

// ---- API keys ------------------------------------------------------------

export async function createApiKeyWithAudit(
  db: Kysely<Database>,
  input: InsertApiKeyInput,
  audit: AuditContext,
): Promise<MutationOutcome> {
  return withAudit(
    db,
    audit,
    {
      action: "keys.create",
      targetType: "api_key",
      targetId: input.api_key_id,
      projectId: input.project_id,
      environment: input.environment as AuditEnvironment,
      before: null,
      after: {
        api_key_id: input.api_key_id,
        project_id: input.project_id,
        environment: input.environment,
        source_id: input.source_id,
        source_type: input.source_type,
        status: "active",
        hash_algorithm: input.hash_algorithm,
      },
    },
    async (trx) => {
      await insertApiKey(trx, input);
      return true;
    },
  );
}

export interface RotateApiKeyOutcome extends MutationOutcome {
  /** Audit id of the `keys.rotate.issue` row. */
  readonly issueAuditId: string;
  /** Audit id of the `keys.rotate.revoke` row. */
  readonly revokeAuditId: string;
}

/**
 * Issue a replacement key and revoke the original, atomically.
 *
 * There is no grace period, by design: the old key stops authenticating the
 * moment this commits. A producer still holding it fails immediately, which
 * is why the CLI prints the replacement before anything else.
 */
export async function rotateApiKeyWithAudit(
  db: Kysely<Database>,
  input: { previous: ApiKeyRow; replacement: InsertApiKeyInput },
  audit: AuditContext & { readonly revokeAuditId: string },
): Promise<RotateApiKeyOutcome> {
  const previousBefore = toApiKeySnapshot(input.previous);

  await db.transaction().execute(async (trx) => {
    await insertApiKey(trx, input.replacement);
    const revoked = await revokeApiKey(trx, input.previous.api_key_id, audit.occurredAt);
    if (!revoked) {
      // The row was already revoked, so this rotation would leave a live
      // replacement paired with nothing revoked — a silently different
      // outcome from what the operator asked for. Roll the whole thing back.
      throw new Error(
        `keys.rotate: ${input.previous.api_key_id} was already revoked; nothing was rotated`,
      );
    }

    await insertAuditRecord(trx, {
      audit_id: audit.auditId,
      actor_source: audit.actorSource,
      actor_label: audit.actorLabel,
      action: "keys.rotate.issue",
      target_type: "api_key",
      target_id: input.replacement.api_key_id,
      project_id: input.replacement.project_id,
      environment: input.replacement.environment as AuditEnvironment,
      before: null,
      after: {
        api_key_id: input.replacement.api_key_id,
        project_id: input.replacement.project_id,
        environment: input.replacement.environment,
        source_id: input.replacement.source_id,
        source_type: input.replacement.source_type,
        status: "active",
        hash_algorithm: input.replacement.hash_algorithm,
        rotated_from: input.previous.api_key_id,
      },
      reason: audit.reason ?? null,
      request_id: audit.requestId ?? audit.auditId,
      created_at: audit.occurredAt,
    });

    await insertAuditRecord(trx, {
      audit_id: audit.revokeAuditId,
      actor_source: audit.actorSource,
      actor_label: audit.actorLabel,
      action: "keys.rotate.revoke",
      target_type: "api_key",
      target_id: input.previous.api_key_id,
      project_id: input.previous.project_id,
      environment: input.previous.environment as AuditEnvironment,
      before: previousBefore satisfies ApiKeyAuditSnapshot,
      after: {
        ...previousBefore,
        status: "revoked",
        revoked_at: audit.occurredAt.toISOString(),
        rotated_to: input.replacement.api_key_id,
      },
      reason: audit.reason ?? null,
      request_id: audit.requestId ?? audit.auditId,
      created_at: audit.occurredAt,
    });
  });

  return {
    applied: true,
    auditId: audit.auditId,
    issueAuditId: audit.auditId,
    revokeAuditId: audit.revokeAuditId,
  };
}

// ---- operator tokens -----------------------------------------------------

export async function createOperatorTokenWithAudit(
  db: Kysely<Database>,
  input: InsertOperatorTokenInput,
  audit: AuditContext,
): Promise<MutationOutcome> {
  return withAudit(
    db,
    audit,
    {
      action: "operators.create",
      targetType: "operator_token",
      targetId: input.operator_token_id,
      // Operator tokens are platform-wide: no project, no environment.
      // The token that can mutate every project is not scoped to one.
      before: null,
      after: {
        operator_token_id: input.operator_token_id,
        operator_label: input.operator_label,
        status: "active",
        hash_algorithm: input.hash_algorithm,
      },
    },
    async (trx) => {
      await insertOperatorToken(trx, input);
      return true;
    },
  );
}

/** Revoke an operator token. Idempotent. */
export async function revokeOperatorTokenWithAudit(
  db: Kysely<Database>,
  input: { row: OperatorTokenRow },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = {
    operator_token_id: input.row.operator_token_id,
    operator_label: input.row.operator_label,
    status: input.row.status,
  };
  return withAudit(
    db,
    audit,
    {
      action: "operators.revoke",
      targetType: "operator_token",
      targetId: input.row.operator_token_id,
      before,
      after: { ...before, status: "revoked", revoked_at: audit.occurredAt.toISOString() },
    },
    (trx) => revokeOperatorToken(trx, input.row.operator_token_id, audit.occurredAt),
  );
}

/** Re-exported so callers can fetch the row the mutations above need. */
export { findApiKeyById };
