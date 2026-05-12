/**
 * Kysely schema view of the Polaris control-plane database.
 *
 * This interface is the typed mirror of the live PostgreSQL schema, which is
 * defined by SQL migrations in `db/migrations/`. The migrations are the
 * source of truth; this file is a hand-maintained typed view that lets
 * Kysely produce typed queries over the real schema.
 *
 * Until each owning task lands its migration, the corresponding table
 * declaration here stays absent. When a new table is added by a later task,
 * extend this interface in the same change that ships the migration.
 *
 * @see packages/shared-db/README.md "Extending the schema"
 */

import type { ColumnType, Generated } from "kysely";

/**
 * `api_keys`: source-scoped write credentials.
 *
 * One row per issued key. Plaintext is never stored. The ingester
 * authenticates incoming requests by looking up the row by `api_key_id`
 * (the public prefix on the wire) and verifying the supplied secret tail
 * against the stored argon2id `hash`. The trusted
 * `(project_id, environment, source_id, source_type)` tuple is stamped onto
 * the canonical envelope from the resolved row — producers may not send or
 * override those fields.
 *
 * Schema reference: `db/migrations/20260512000002_create_api_keys.sql`.
 */
export interface ApiKeyTable {
  /** Public prefix on the wire and primary key. UUIDv7 in the v1 issuer. */
  api_key_id: string;
  /** Project that owns this key. Stamped onto every accepted event. */
  project_id: string;
  /**
   * Deployment environment this key is bound to. The ingester stamps
   * `environment` from the key, not from the producer-supplied payload.
   */
  environment: string;
  /** Source identifier this key authenticates (e.g. `storefront-web`). */
  source_id: string;
  /** Source type (`web`, `backend`, `webhook`, `job`, ...). */
  source_type: string;
  /**
   * Hash of the secret tail. NEVER plaintext. The algorithm is recorded in
   * `hash_algorithm` so future rotations to a different primitive (or to
   * stronger argon2id parameters) can land without a schema change.
   */
  hash: string;
  /** Hash algorithm identifier. Defaults to `argon2id`. */
  hash_algorithm: Generated<string>;
  /**
   * Lifecycle status. The ingester treats anything other than `'active'` as
   * not usable. v1 emits `'active'` and `'revoked'` only; future states
   * (`'paused'`, `'pending_rotation'`) can land without a type change.
   */
  status: Generated<string>;
  /** Issuance time, in UTC (timestamptz column on the database side). */
  created_at: ColumnType<Date, string | Date | undefined, never>;
  /** Revocation time. NULL while the key is active. */
  revoked_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  /**
   * Last successful authentication time. The ingester updates this column
   * out-of-band (per-key write coalescing) so it does not gate the hot path.
   */
  last_used_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

// Declared as an interface (not a type alias) so future tasks can extend it
// via declaration merging from their own packages, e.g.
//
//   declare module "@polaris/shared-db" {
//     interface Database { sources: SourcesTable }
//   }
export interface Database {
  api_keys: ApiKeyTable;
}
