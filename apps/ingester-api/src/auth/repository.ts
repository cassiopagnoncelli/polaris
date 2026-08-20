/**
 * `api_keys` lookup repository.
 *
 * Thin abstraction over `@polaris/persistence-postgres` so the auth layer can be unit
 * tested with an in-memory fake. The repository is read-only at the ingester
 * — issuance, revocation, and rotation are P6-003 (lifecycle CLI) territory.
 *
 * @see libs/persistence/postgres/src/database.ts ApiKeyTable
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

/**
 * The subset of the `api_keys` row the ingester needs to authenticate a
 * request and stamp the trusted envelope tuple. The repository deliberately
 * omits `created_at` / `last_used_at` — those are lifecycle CLI concerns and
 * keeping them off this type makes it harder to accidentally surface them
 * through the auth context.
 */
export interface ApiKeyRecord {
  readonly apiKeyId: string;
  readonly projectId: string;
  readonly environment: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly hash: string;
  readonly hashAlgorithm: string;
  readonly status: string;
}

/**
 * Lookup contract used by the auth layer. The cache and tests implement
 * this same surface so the auth service has a single seam.
 */
export interface ApiKeyRepository {
  /**
   * Find a single key row by its public `api_key_id`. Returns `null` when
   * no row matches. Revoked rows are returned as-is so the caller can
   * distinguish "no such key" from "revoked key" in metrics; both still
   * surface as `invalid_api_key` on the wire.
   */
  findById(apiKeyId: string): Promise<ApiKeyRecord | null>;
}

/**
 * Build a PostgreSQL-backed repository over a typed Kysely client.
 */
export function createPostgresApiKeyRepository(db: Kysely<Database>): ApiKeyRepository {
  return {
    async findById(apiKeyId) {
      const row = await db
        .selectFrom("api_keys")
        .select([
          "api_key_id",
          "project_id",
          "environment",
          "source_id",
          "source_type",
          "hash",
          "hash_algorithm",
          "status",
        ])
        .where("api_key_id", "=", apiKeyId)
        .executeTakeFirst();
      if (!row) return null;
      return {
        apiKeyId: row.api_key_id,
        projectId: row.project_id,
        environment: row.environment,
        sourceId: row.source_id,
        sourceType: row.source_type,
        hash: row.hash,
        hashAlgorithm: row.hash_algorithm,
        status: row.status,
      };
    },
  };
}
