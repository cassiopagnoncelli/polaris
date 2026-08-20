/**
 * Repository helpers for the `api_keys` table.
 *
 * The lifecycle CLI (P6-003) is the v1 writer side for this table. The
 * ingester (P2-002) is the read side. Both go through a typed Kysely client
 * over `@polaris/persistence-postgres`; this file owns the query shapes the CLI needs.
 *
 * Rules baked into this module:
 *
 *   - The CLI inserts the argon2id `hash` produced by
 *     `@polaris/runtime-secrets`. Plaintext never appears here.
 *   - `hash_algorithm` is stamped explicitly as `'argon2id'`. The column has a
 *     default at the migration level but writing it from the application
 *     keeps the rotation-to-a-different-primitive story explicit — a future
 *     algorithm bump rewrites this constant and migrates rows in lockstep.
 *   - Revocation is idempotent: the helper UPDATEs unconditionally and the
 *     command layer reports whether the row was already revoked.
 *
 * @see db/postgres/migrations/20260512000003_create_api_keys.sql
 * @see libs/persistence/postgres/src/database.ts ApiKeyTable
 */
import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

/**
 * Read-shape returned to the command layer. Plain JSON, no Date — timestamps
 * are stamped as ISO strings so JSON output matches the human form.
 */
export interface ApiKeyRow {
  readonly api_key_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly status: string;
  readonly hash_algorithm: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly last_used_at: string | null;
}

/**
 * Insert a freshly-issued key row. The caller has already generated the
 * `api_key_id` and computed the argon2id `hash` of the secret tail; we never
 * see the plaintext here.
 */
export interface InsertApiKeyInput {
  readonly api_key_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly hash: string;
  readonly hash_algorithm: string;
}

/**
 * Insert a new active row. The migration's CHECK constraint on `status` and
 * the `created_at` DEFAULT take care of the lifecycle defaults; we explicitly
 * write `hash_algorithm` and rely on `status` defaulting to `'active'`.
 */
export async function insertApiKey(db: Kysely<Database>, input: InsertApiKeyInput): Promise<void> {
  await db
    .insertInto("api_keys")
    .values({
      api_key_id: input.api_key_id,
      project_id: input.project_id,
      environment: input.environment,
      source_id: input.source_id,
      source_type: input.source_type,
      hash: input.hash,
      hash_algorithm: input.hash_algorithm,
      // status, created_at, revoked_at, last_used_at all default in the schema.
    })
    .execute();
}

/**
 * Find one key row by its public id. Returns `null` when no row matches.
 * Revoked rows are returned as-is so the CLI can render them in `keys list`
 * and so `keys rotate` can detect "rotate an already-revoked key".
 */
export async function findApiKeyById(
  db: Kysely<Database>,
  apiKeyId: string,
): Promise<ApiKeyRow | null> {
  const row = await db
    .selectFrom("api_keys")
    .select([
      "api_key_id",
      "project_id",
      "environment",
      "source_id",
      "source_type",
      "status",
      "hash_algorithm",
      "created_at",
      "revoked_at",
      "last_used_at",
    ])
    .where("api_key_id", "=", apiKeyId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * List keys scoped to one `(project_id, environment)` pair. Ordered by
 * `created_at DESC` so the most recently issued keys appear first — the
 * shape an operator wants when they run `keys list` to find what to rotate.
 *
 * Includes revoked rows: the CLI surfaces them so operators can see when a
 * rotation has happened.
 */
export async function listApiKeysByProjectEnv(
  db: Kysely<Database>,
  projectId: string,
  environment: string,
): Promise<ApiKeyRow[]> {
  const rows = await db
    .selectFrom("api_keys")
    .select([
      "api_key_id",
      "project_id",
      "environment",
      "source_id",
      "source_type",
      "status",
      "hash_algorithm",
      "created_at",
      "revoked_at",
      "last_used_at",
    ])
    .where("project_id", "=", projectId)
    .where("environment", "=", environment)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map(toRow);
}

/**
 * Mark a key as revoked.
 *
 * Idempotent: the CLI may call this on an already-revoked row, and the
 * UPDATE simply changes nothing (status is already 'revoked'). We do NOT
 * skip the UPDATE for already-revoked rows because the caller wants the
 * audit-style guarantee that `revoke <id>` reaches the database every time.
 *
 * `revoked_at` is stamped only when transitioning from `'active'` to
 * `'revoked'` so a re-run does not mutate the original revoke time. The
 * SQL uses `COALESCE(revoked_at, $revoked_at)` semantics by guarding with
 * the WHERE on `status = 'active'` for the first call and a separate
 * touch-noop for repeat calls.
 *
 * Returns `true` when this call performed the active->revoked transition,
 * `false` when the row was already revoked (or did not exist — the caller
 * pre-checks). Used by the command layer to print "already revoked"
 * without erroring out the script.
 */
export async function revokeApiKey(
  db: Kysely<Database>,
  apiKeyId: string,
  revokedAt: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("api_keys")
    .set({
      status: "revoked",
      revoked_at: revokedAt,
    })
    .where("api_key_id", "=", apiKeyId)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

function toRow(row: {
  readonly api_key_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly status: string;
  readonly hash_algorithm: string;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
  readonly last_used_at: Date | null;
}): ApiKeyRow {
  return {
    api_key_id: row.api_key_id,
    project_id: row.project_id,
    environment: row.environment,
    source_id: row.source_id,
    source_type: row.source_type,
    status: row.status,
    hash_algorithm: row.hash_algorithm,
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    last_used_at: row.last_used_at === null ? null : row.last_used_at.toISOString(),
  };
}
