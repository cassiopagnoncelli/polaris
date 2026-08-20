/**
 * Repository helpers for the `operator_tokens` table.
 *
 * The lifecycle CLI (P6-007) is the v1 writer side. The dispatcher's
 * resolver (`@polaris/shared-control-plane`) is the read side. Both go
 * through a typed Kysely client over `@polaris/shared-db`; this file owns
 * the query shapes and the typed `OperatorTokensTable` interface.
 *
 * The typed `OperatorTokensTable` interface extends `@polaris/shared-db`'s
 * `Database` interface through module augmentation — the same pattern
 * `audit-records.ts` (P6-006) uses. This keeps the migration SQL the
 * schema source-of-truth (the `Database` interface in `shared-db` carries
 * the columns of tables that have already landed) while letting later
 * tasks extend the typed surface from their own package without an
 * inter-package edit.
 *
 * Rules baked into this module:
 *
 *   - The CLI inserts the argon2id `hash` produced by
 *     `@polaris/shared-secrets`. Plaintext NEVER enters this module.
 *   - `hash_algorithm` is stamped explicitly. The column has a default at
 *     the migration level but writing it from the application makes a
 *     future primitive bump explicit.
 *   - Revocation is idempotent: the helper UPDATEs unconditionally and
 *     the command layer reports whether the row was already revoked.
 *   - `last_used_at` is updated out-of-band by the resolver via the
 *     `OperatorTokenRepository` contract. The update path is best-effort:
 *     failures are swallowed upstream, not surfaced here.
 *
 * @see db/migrations/20260512000009_create_operator_tokens.sql
 * @see libs/tenancy/control-plane/src/resolver.ts
 */
import type { Database } from "@polaris/shared-db";
import type { ColumnType, Kysely } from "kysely";

/**
 * Closed set of `operator_tokens.status` values, mirroring the
 * `operator_tokens_status_allowed` CHECK constraint in the migration.
 */
export const OPERATOR_TOKEN_STATUSES = ["active", "revoked"] as const;
export type OperatorTokenStatus = (typeof OPERATOR_TOKEN_STATUSES)[number];

/**
 * Typed mirror of the `operator_tokens` table.
 *
 * Extends `@polaris/shared-db`'s `Database` interface via module
 * augmentation (the `declare module` below) so any
 * `Kysely<Database>` instance in the CLI gets
 * `db.selectFrom("operator_tokens")` typed automatically.
 */
export interface OperatorTokensTable {
  operator_token_id: string;
  operator_label: string;
  hash: string;
  hash_algorithm: ColumnType<string, string | undefined, string>;
  status: ColumnType<OperatorTokenStatus, OperatorTokenStatus | undefined, OperatorTokenStatus>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  revoked_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  last_used_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

declare module "@polaris/shared-db" {
  interface Database {
    operator_tokens: OperatorTokensTable;
  }
}

/**
 * Read-shape returned to the command layer. Plain JSON: timestamps stamped
 * as ISO strings so the `human` and `json` renderers see the same value.
 * The argon2id `hash` is intentionally OMITTED from this view so no
 * render path can ever surface it.
 */
export interface OperatorTokenRow {
  readonly operator_token_id: string;
  readonly operator_label: string;
  readonly hash_algorithm: string;
  readonly status: OperatorTokenStatus;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly last_used_at: string | null;
}

/**
 * The wider read-shape used by the resolver. Differs from
 * {@link OperatorTokenRow} in that it INCLUDES the argon2id `hash` because
 * the resolver needs it to verify the supplied secret tail. The resolver
 * never logs, persists, or echoes this value.
 */
export interface OperatorTokenAuthRow {
  readonly operator_token_id: string;
  readonly operator_label: string;
  readonly hash: string;
  readonly hash_algorithm: string;
  readonly status: OperatorTokenStatus;
}

/**
 * Insert payload accepted by {@link insertOperatorToken}.
 *
 * The caller has already generated `operator_token_id` (polaris_ot_<uuidv7>)
 * and computed the argon2id `hash` of the secret tail; this module never
 * sees the plaintext.
 */
export interface InsertOperatorTokenInput {
  readonly operator_token_id: string;
  readonly operator_label: string;
  readonly hash: string;
  readonly hash_algorithm: string;
}

/**
 * INSERT a freshly-issued operator-token row. `status` defaults to
 * `'active'` and `created_at` defaults to `now()` at the schema level; we
 * stamp `hash_algorithm` explicitly so the application owns the
 * lockstep-with-shared-secrets invariant.
 */
export async function insertOperatorToken(
  db: Kysely<Database>,
  input: InsertOperatorTokenInput,
): Promise<void> {
  await db
    .insertInto("operator_tokens")
    .values({
      operator_token_id: input.operator_token_id,
      operator_label: input.operator_label,
      hash: input.hash,
      hash_algorithm: input.hash_algorithm,
    })
    .execute();
}

/**
 * Look up one row by its public id WITHOUT the hash. Used by `operators
 * revoke` and `operators list` (single-row mode). Returns `null` for an
 * unknown id.
 */
export async function findOperatorTokenById(
  db: Kysely<Database>,
  operatorTokenId: string,
): Promise<OperatorTokenRow | null> {
  const row = await db
    .selectFrom("operator_tokens")
    .select([
      "operator_token_id",
      "operator_label",
      "hash_algorithm",
      "status",
      "created_at",
      "revoked_at",
      "last_used_at",
    ])
    .where("operator_token_id", "=", operatorTokenId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * Look up one row INCLUDING the argon2id `hash`. Used by the resolver
 * (`@polaris/shared-control-plane`) at dispatcher time. Returns `null` for
 * an unknown id.
 *
 * Separate from {@link findOperatorTokenById} on purpose: the read view
 * the command layer sees (and that may flow into output) excludes the
 * hash; the read view the resolver sees includes it. The split makes
 * "leak the hash to operator output" impossible at the type level.
 */
export async function findOperatorTokenAuthRowById(
  db: Kysely<Database>,
  operatorTokenId: string,
): Promise<OperatorTokenAuthRow | null> {
  const row = await db
    .selectFrom("operator_tokens")
    .select(["operator_token_id", "operator_label", "hash", "hash_algorithm", "status"])
    .where("operator_token_id", "=", operatorTokenId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return row;
}

/**
 * List rows ordered by `created_at DESC`. Used by `operators list`.
 *
 * By default we return everything (active + revoked) so operators can
 * audit a full lifecycle without a separate command. Passing
 * `statusFilter: 'active'` narrows to live rows for the `--status active`
 * CLI option.
 */
export async function listOperatorTokens(
  db: Kysely<Database>,
  options: { readonly statusFilter?: OperatorTokenStatus; readonly limit?: number } = {},
): Promise<OperatorTokenRow[]> {
  let query = db
    .selectFrom("operator_tokens")
    .select([
      "operator_token_id",
      "operator_label",
      "hash_algorithm",
      "status",
      "created_at",
      "revoked_at",
      "last_used_at",
    ]);
  if (options.statusFilter !== undefined) {
    query = query.where("status", "=", options.statusFilter);
  }
  const limit = options.limit ?? 200;
  query = query.orderBy("created_at", "desc").limit(limit);
  const rows = await query.execute();
  return rows.map(toRow);
}

/**
 * Mark a row as revoked, stamping `revoked_at`. Idempotent: the WHERE
 * guard on `status = 'active'` means a second call is a noop and the
 * original `revoked_at` is preserved. Returns `true` when this call did
 * the active->revoked transition; `false` when the row was already
 * revoked or did not exist.
 */
export async function revokeOperatorToken(
  db: Kysely<Database>,
  operatorTokenId: string,
  revokedAt: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("operator_tokens")
    .set({
      status: "revoked",
      revoked_at: revokedAt,
    })
    .where("operator_token_id", "=", operatorTokenId)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Best-effort `last_used_at` touch. The resolver swallows failures so a
 * transient DB outage cannot block a mutation; this function is the
 * Kysely-backed implementation that the CLI wires into the resolver via
 * the `OperatorTokenRepository.touchLastUsedAt` contract.
 */
export async function touchOperatorTokenLastUsedAt(
  db: Kysely<Database>,
  operatorTokenId: string,
  at: Date,
): Promise<void> {
  await db
    .updateTable("operator_tokens")
    .set({ last_used_at: at })
    .where("operator_token_id", "=", operatorTokenId)
    .execute();
}

function toRow(row: {
  readonly operator_token_id: string;
  readonly operator_label: string;
  readonly hash_algorithm: string;
  readonly status: OperatorTokenStatus;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
  readonly last_used_at: Date | null;
}): OperatorTokenRow {
  return {
    operator_token_id: row.operator_token_id,
    operator_label: row.operator_label,
    hash_algorithm: row.hash_algorithm,
    status: row.status,
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    last_used_at: row.last_used_at === null ? null : row.last_used_at.toISOString(),
  };
}
