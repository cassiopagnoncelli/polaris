/**
 * Kysely schema view of the Polaris control-plane database.
 *
 * This interface is the typed mirror of the live PostgreSQL schema, which is
 * defined by SQL migrations in `db/migrations/`. The migrations are the
 * source of truth; this file is a hand-maintained typed view that lets
 * Kysely produce typed queries over the real schema.
 *
 * When a new table is added by a later task, extend this interface in the
 * same change that ships the migration.
 *
 * @see packages/shared-db/README.md "Extending the schema"
 */

import type { ColumnType, Generated } from "kysely";

/**
 * Fixed runtime environments. Future ephemeral environments may exist but are
 * out of scope until they're explicitly added to this union.
 *
 * Mirrors the closed set baked into the `sources_allowed_environments_members`
 * CHECK constraint in `db/migrations/20260512000003_create_sources.sql`.
 */
export type Environment = "development" | "staging" | "production";

/**
 * Closed set of source types. Mirrors the
 * `sources_source_type_allowed` CHECK constraint. Adding a new variant requires
 * a follow-up migration to widen the CHECK, plus updates to the catalog Zod
 * schema in `apps/polaris-cli/src/catalog/`.
 */
export type SourceType = "web" | "backend" | "mobile" | "webhook" | "job";

/**
 * Runtime toggle for sources. `active` lets the ingester resolve the source;
 * `paused` keeps the materialized row but rejects traffic at the gate.
 */
export type SourceRuntime = "active" | "paused";

/** Visibility status mirrored on both projects and sources. */
export type ProjectStatus = "active" | "disabled";
export type SourceStatus = "active" | "disabled";

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

/**
 * `projects` table.
 *
 * Materialized from `catalog/projects/<project_id>.yaml`. Semantic membership
 * is file-backed; this row exists so PostgreSQL FK relationships (sources,
 * api_keys, audit records) can hang off a stable `project_id`.
 */
export interface ProjectsTable {
  project_id: string;
  display_name: string;
  owner: string;
  description: string;
  status: ColumnType<ProjectStatus, ProjectStatus | undefined, ProjectStatus>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * `sources` table.
 *
 * Materialized from `catalog/sources/<project_id>/<source_id>.yaml`. The
 * ingester reads this row through an in-memory or Redis cache to resolve
 * `project_id + environment + source_id` against the active runtime state.
 */
export interface SourcesTable {
  project_id: string;
  source_id: string;
  source_type: SourceType;
  owner: string;
  description: string;
  runtime: ColumnType<SourceRuntime, SourceRuntime | undefined, SourceRuntime>;
  allowed_environments: Environment[];
  status: ColumnType<SourceStatus, SourceStatus | undefined, SourceStatus>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

// Declared as an interface (not a type alias) so future tasks can extend it
// via declaration merging from their own packages, e.g.
//
//   declare module "@polaris/shared-db" {
//     interface Database { audit_records: AuditRecordsTable }
//   }
//
// As migrations land, add a new property here in the same change.
export interface Database {
  api_keys: ApiKeyTable;
  projects: ProjectsTable;
  sources: SourcesTable;
}
