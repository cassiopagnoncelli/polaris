/**
 * PostgreSQL-backed implementation of {@link AllowedOriginsRepository}.
 *
 * Reads from the `source_allowed_origins` table created by
 * `db/postgres/migrations/20260512000011_create_source_allowed_origins.sql`.
 *
 * The repository is read-only at the ingester. Issuance/revocation of
 * origin entries is a CLI concern (a sibling task in the P6 cluster — see
 * the task card for the deferred CLI surface).
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

import type { AllowedOriginsRepository, AllowedOriginsResult, OriginLookupInput } from "./types.js";

/**
 * Build a PostgreSQL-backed repository over a typed Kysely client.
 */
export function createPostgresAllowedOriginsRepository(
  db: Kysely<Database>,
): AllowedOriginsRepository {
  return {
    async findFor(input: OriginLookupInput): Promise<AllowedOriginsResult> {
      const rows = await db
        .selectFrom("source_allowed_origins")
        .select(["origin"])
        .where("project_id", "=", input.projectId)
        .where("source_id", "=", input.sourceId)
        .where("environment", "=", input.environment)
        .execute();
      // Freeze the result so callers cannot mutate the cached snapshot.
      return Object.freeze(rows.map((row) => row.origin));
    },
  };
}
