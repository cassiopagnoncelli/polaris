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

/**
 * Runtime status of a destination instance. The destination consumer treats
 * anything other than `'active'` as not-deliverable; `paused` keeps the row
 * but stops dispatch, `disabled` is the terminal state for retired instances.
 */
export type DestinationStatus = "active" | "paused" | "disabled";

/**
 * Delivery mode for a destination instance. Non-semantic operational dial:
 *   - `live`     production delivery to the vendor
 *   - `sandbox`  vendor-side sandbox endpoint (where supported)
 *   - `test`     no network delivery; used by smoke tests and replay dry runs
 *
 * Modes do not change event-to-vendor mapping behavior. Mapping semantics
 * live in `consumers/<vendor>/v<n>/mappers/`, never here.
 */
export type DestinationMode = "live" | "sandbox" | "test";

/**
 * Retry-policy profile. Operational tuning only — never alters event meaning.
 * Mirrors the closed set baked into the
 * `destinations_retry_policy_allowed` CHECK constraint.
 */
export type DestinationRetryPolicy = "standard" | "aggressive" | "conservative";

/**
 * `destinations` table.
 *
 * Runtime instances of vendor-adapter consumers (Meta CAPI, GA4, TikTok,
 * Braze, webhook-sink, reverse-etl). One row per deployed destination per
 * `(project, environment)`. The row stores runtime state and operational
 * knobs only.
 *
 * **PostgreSQL DOES NOT store mapping semantics.** Mapping semantics
 * (event-to-vendor field maps) live in versioned consumer code under
 * `consumers/<vendor>/v<n>/mappers/`. This interface intentionally has NO
 * column resembling `field_map`, `mapping`, `event_map`, `target_field`, or
 * any other field-translation surface. The CLI cannot define mappings
 * because the typed schema gives it nowhere to store them, and the
 * migration's column set matches this contract.
 *
 * Schema reference: `db/migrations/20260512000005_create_destinations.sql`.
 */
export interface DestinationsTable {
  /** Platform-issued public id, e.g. `polaris_dst_<uuidv7>`. */
  destination_id: string;
  /** Project that owns this destination. References `projects(project_id)`. */
  project_id: string;
  /** Deployment environment. Closed set: development | staging | production. */
  environment: string;
  /**
   * Vendor adapter name (e.g. `meta-capi`, `ga4`, `tiktok`, `braze`,
   * `webhook-sink`, `reverse-etl`). Free-form-with-CHECK rather than a TS
   * union because the consumer codebase grows independently of this
   * package; the migration's regex enforces shape, not membership.
   */
  vendor: string;
  /**
   * Operator-supplied short label, unique within
   * `(project, environment, vendor)`. Used in CLI output and audit logs.
   */
  instance_label: string;
  /**
   * Provider-namespaced secret reference (e.g.
   * `env:META_CAPI_TOKEN_STOREFRONT_PROD`,
   * `secret_manager:polaris/production/storefront/meta-capi`). The runtime
   * resolves this through `@polaris/shared-secrets`; the resolved value is
   * never persisted here.
   */
  secret_ref: string;
  /** Lifecycle status (`active` | `paused` | `disabled`). */
  status: ColumnType<DestinationStatus, DestinationStatus | undefined, DestinationStatus>;
  /** Delivery mode (`live` | `sandbox` | `test`). */
  mode: ColumnType<DestinationMode, DestinationMode | undefined, DestinationMode>;
  /** Operational knob: per-instance worker concurrency. */
  max_concurrency: ColumnType<number, number | undefined, number>;
  /** Operational knob: outbound vendor request rate cap. */
  max_rps: ColumnType<number, number | undefined, number>;
  /** Operational knob: retry-policy profile (closed set). */
  retry_policy: ColumnType<
    DestinationRetryPolicy,
    DestinationRetryPolicy | undefined,
    DestinationRetryPolicy
  >;
  /** Operational knob: attempts after which a message is routed to the DLQ. */
  dead_letter_threshold: ColumnType<number, number | undefined, number>;
  /**
   * Free-text rationale stamped by `polaris destinations disable --reason
   * <reason>`. NULL when the destination is not disabled. Cleared on
   * `enable` so the column always reflects the most recent disable.
   */
  disabled_reason: ColumnType<string | null, string | null | undefined, string | null>;
  /** Issuance time, in UTC. */
  created_at: Generated<Date>;
  /** Last mutation time, in UTC. Stamped on every UPDATE. */
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * Runtime activation state for a versioned processor.
 *
 * `enabled` means the processor runtime (P8-001) treats this
 * `(processor_name, processor_version, project_id, environment)` tuple as
 * runnable. `disabled` keeps the row for audit/state-change history but stops
 * the runtime from picking up traffic.
 *
 * The set is intentionally minimal in v1. A future `paused` state would be
 * added here AND to the `processor_activations_enabled_state_allowed` CHECK
 * constraint in the same change.
 */
export type ProcessorActivationState = "enabled" | "disabled";

/**
 * `processor_activations` table.
 *
 * Per `(processor_name, processor_version, project_id, environment)`, this
 * row records whether the processor is enabled in that scope, plus the
 * last-toggle timestamps and a free-text `last_changed_by` actor label.
 *
 * **PostgreSQL DOES NOT store processor transform rules.** The semantic
 * definition of every processor (inputs, outputs, mode, transform code)
 * lives in `processors/<name>/v<n>/processor.manifest.yaml` and
 * `processors/<name>/v<n>/src/`. This interface intentionally has NO column
 * resembling `transform`, `rule`, `mapping`, `input_topic`, `output_topic`,
 * `config_blob`, `routing`, `enrichment`, or any other transform-rule
 * surface. The CLI cannot define semantics because the typed schema gives
 * it nowhere to store them, and the migration's column set matches this
 * contract.
 *
 * Schema reference:
 *   db/migrations/20260512000006_create_processor_activations.sql
 */
export interface ProcessorActivationsTable {
  /** Processor catalog name (e.g. `analytics-projector`). */
  processor_name: string;
  /**
   * Immutable version directory under `processors/<name>/`. Free-form text
   * (e.g. `v1`, `v2`, `v1.2.3`) — the manifest file on disk is the source of
   * truth for which versions actually exist.
   */
  processor_version: string;
  /** Project this activation row scopes to. References `projects(project_id)`. */
  project_id: string;
  /** Deployment environment. Closed set: development | staging | production. */
  environment: string;
  /** Runtime toggle (`enabled` | `disabled`). */
  enabled_state: ColumnType<
    ProcessorActivationState,
    ProcessorActivationState | undefined,
    ProcessorActivationState
  >;
  /** Last `enabled` transition timestamp. NULL when never enabled. */
  enabled_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Last `disabled` transition timestamp. NULL when never disabled. */
  disabled_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /**
   * Free-text actor label. P6-007 will populate this with the authenticated
   * operator token's actor id; until then it defaults to `'cli'`. The
   * authoritative audit trail lives in `audit_records` (P6-006); this column
   * is a convenience marker.
   */
  last_changed_by: ColumnType<string, string | undefined, string>;
  /** Issuance time, in UTC. */
  created_at: Generated<Date>;
  /** Last mutation time, in UTC. Stamped on every UPDATE. */
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
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
  destinations: DestinationsTable;
  processor_activations: ProcessorActivationsTable;
  projects: ProjectsTable;
  sources: SourcesTable;
}
