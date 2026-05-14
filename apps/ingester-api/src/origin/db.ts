/**
 * Module augmentation extending `@polaris/shared-db`'s `Database` interface
 * with the `source_allowed_origins` table.
 *
 * Same pattern P6-006 (audit_records), P6-007 (operator_tokens), and P7-001
 * (replay_jobs) use to keep the typed schema co-located with the migration
 * that creates it. The shared-db package stays scope-tight — its README
 * documents this augmentation as the canonical way to add tables owned by
 * a feature package.
 *
 * Schema reference:
 *   `db/migrations/20260512000013_create_source_allowed_origins.sql`.
 */

import type { ColumnType, Generated } from "kysely";

/**
 * `source_allowed_origins` table.
 *
 * Per-source CORS allow-list scoped by environment. The ingester reads this
 * table through a short cache (mirrors the API-key cache lifetime) to decide
 * whether a request from a browser with a given `Origin` header is allowed
 * to hit `POST /v1/events`.
 *
 * Deny-by-default: a source with zero rows refuses every cross-origin
 * browser request. Server-to-server callers (no `Origin` header) bypass the
 * check — only browsers carry a meaningful `Origin`.
 */
export interface SourceAllowedOriginsTable {
  project_id: string;
  source_id: string;
  /** Closed set: `development | staging | production`. */
  environment: string;
  /**
   * Case-sensitive `<scheme>://<host>[:<port>]` string (e.g.
   * `https://shop.example.com`). Trailing slashes are forbidden by the
   * CHECK constraint. The wildcard `*` origin is forbidden — allow-listing
   * the entire web defeats the purpose of the check.
   */
  origin: string;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

declare module "@polaris/shared-db" {
  interface Database {
    source_allowed_origins: SourceAllowedOriginsTable;
  }
}
