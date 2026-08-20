/**
 * Audited API-key mutations.
 *
 * Revocation only. Issuance and rotation stay where they are: both return
 * plaintext key material exactly once, and a shared function that hands a
 * secret back to two very different callers is a shape worth not having.
 * (The admin UI renders the `polaris keys create` command instead — see
 * `apps/control-plane-api/src/admin/pages/keys.ts`.)
 *
 * The snapshot mirrors the CLI's byte for byte, including `hash_algorithm`
 * and excluding `hash`. Audit rows record what changed about a credential,
 * never the credential.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

import { type ApiKeyRow, revokeApiKey } from "../queries/api-keys.js";
import type { AuditEnvironment } from "../queries/audit-records.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

export interface ApiKeyAuditSnapshot {
  readonly api_key_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly status: string;
  readonly hash_algorithm: string;
  readonly revoked_at: string | Date | null;
}

export function toApiKeySnapshot(row: ApiKeyRow): ApiKeyAuditSnapshot {
  return {
    api_key_id: row.api_key_id,
    project_id: row.project_id,
    environment: row.environment,
    source_id: row.source_id,
    source_type: row.source_type,
    status: row.status,
    hash_algorithm: row.hash_algorithm,
    revoked_at: row.revoked_at,
  };
}

/**
 * Revoke an API key.
 *
 * Idempotent: revoking an already-revoked key reports `applied: false` and
 * writes no audit row. Revocation takes effect the moment the transaction
 * commits — there is no grace period, so a producer using this key stops
 * being able to ingest immediately.
 */
export async function revokeApiKeyWithAudit(
  db: Kysely<Database>,
  input: { row: ApiKeyRow },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toApiKeySnapshot(input.row);
  return withAudit(
    db,
    audit,
    {
      action: "keys.revoke",
      targetType: "api_key",
      targetId: input.row.api_key_id,
      projectId: input.row.project_id,
      environment: input.row.environment as AuditEnvironment,
      before,
      after: { ...before, status: "revoked", revoked_at: audit.occurredAt.toISOString() },
    },
    (trx) => revokeApiKey(trx, input.row.api_key_id, audit.occurredAt),
  );
}
