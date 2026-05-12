/**
 * Kysely schema view of the Polaris control-plane database.
 *
 * This interface is the typed mirror of the live PostgreSQL schema, which is
 * defined by SQL migrations in `db/migrations/`. The migrations are the
 * source of truth; this file is a hand-maintained typed view that lets
 * Kysely produce typed queries over the real schema.
 *
 * Until each owning task lands its migration, the corresponding table
 * declaration here stays absent. The current bootstrap migration
 * (`20260512000001_bootstrap.sql`) does not create any application tables,
 * so this interface is empty by design.
 *
 * When a new table is added by a later task, extend this interface in the
 * same change that ships the migration. A small example for reference (do
 * not enable until the migration exists):
 *
 *   export interface Database {
 *     api_keys: {
 *       api_key_id: string;
 *       project_id: string;
 *       environment: 'development' | 'staging' | 'production';
 *       hash: string;
 *       created_at: Date;
 *       revoked_at: Date | null;
 *     };
 *   }
 *
 * Until then, the empty interface keeps `Kysely<Database>` typeable while
 * making it impossible to query a table that does not exist.
 */
export type Database = {
  // Intentionally empty. See file header.
};
