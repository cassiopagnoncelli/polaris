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
  /**
   * Per-instance replay opt-in (P7-004). DEFAULTS to `false`: every
   * destination is opt-out-by-default per
   * `docs/architecture/05-processors-and-replay.md` "Replay Control
   * Plane" and `docs/architecture/06-destinations.md` "Delivery Model".
   * Operators flip the column via `polaris destinations enable-replay
   * <id> --reason <text>`, which writes an audit row in the same
   * transaction. The runtime consults this column alongside the
   * host-level `allowReplay` flag in
   * `packages/shared-destinations/src/replay-suppression.ts`; replay
   * traffic against an opted-out destination is suppressed with a
   * structured log line and a `polaris_destination_replay_suppressed_total`
   * metric increment.
   */
  replay_opt_in: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Operator-supplied rationale for the most recent enable-replay /
   * disable-replay transition. NULL until the first opt-in. The CHECK
   * constraint `destinations_replay_opt_in_reason_when_enabled` enforces
   * that an opted-in row always carries a non-null reason; the audit
   * history in `audit_records` carries every transition.
   */
  replay_opt_in_reason: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Wall-clock timestamp of the most recent enable-replay transition.
   * NULL until the first opt-in. Disable-replay does NOT clear this
   * column — operators may want to see the last time replay was active
   * even after it has been turned off. The boolean is the authoritative
   * gate; this column is informational.
   */
  replay_opt_in_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
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

/**
 * Closed set of `processor_runs.status` values. Mirrors the
 * `processor_runs_status_allowed` CHECK constraint in
 * `db/migrations/20260512000007_create_processor_runs.sql`.
 *
 * Transitions:
 *   - `running` -> `completed` (graceful stop, no fatal error)
 *   - `running` -> `failed`    (fatal error caught by the runtime)
 *   - `running` -> `cancelled` (operator-issued stop)
 *
 * Terminal states are immutable in the runtime helpers — see
 * `@polaris/shared-processor`'s `InvalidRunTransitionError`.
 */
export type ProcessorRunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * `processor_runs` table.
 *
 * One row per processor execution. The semantic definition of every
 * processor (inputs, outputs, mode, transform code) lives in
 * `processors/<name>/v<n>/processor.manifest.yaml`. This table records ONLY
 * runtime state: which run happened, when, with what outcome and counters.
 *
 * The Kafka consumer-group committed offset remains the authoritative
 * checkpoint for resumption — `last_offset` here is informational, used by
 * operators to see the latest position the run observed without consulting
 * the broker.
 *
 * Schema reference:
 *   db/migrations/20260512000007_create_processor_runs.sql
 */
export interface ProcessorRunsTable {
  /** Platform-generated UUIDv7. Primary key. */
  run_id: string;
  /** Processor catalog name (matches the directory under `processors/`). */
  processor_name: string;
  /**
   * Immutable version directory under `processors/<name>/`. Free-form text
   * (e.g. `v1`, `v2`, `v1.2.3`); the manifest on disk is the source of
   * truth for which versions actually exist.
   */
  processor_version: string;
  /** Optional project scope. NULL for cross-project processors. */
  project_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Optional environment scope. Closed set:
   * `development | staging | production`. NULL when the run is not
   * environment-scoped (e.g. one-off operator job).
   */
  environment: ColumnType<string | null, string | null | undefined, string | null>;
  /** When the run started. Defaults to `now()` server-side. */
  started_at: ColumnType<Date, Date | string | undefined, Date | string>;
  /** When the run reached a terminal status. NULL while still running. */
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Lifecycle status. See {@link ProcessorRunStatus}. */
  status: ColumnType<ProcessorRunStatus, ProcessorRunStatus | undefined, ProcessorRunStatus>;
  /** Count of input events the run consumed. Monotonic. */
  events_consumed: ColumnType<number, number | undefined, number>;
  /** Count of derived events the run emitted. Monotonic. */
  events_emitted: ColumnType<number, number | undefined, number>;
  /** Count of events the run failed on (after classification). Monotonic. */
  events_failed: ColumnType<number, number | undefined, number>;
  /**
   * Latest RabbitMQ offset observed by the run. INFORMATIONAL — the Kafka
   * committed offset is the authoritative resume point. `bigint` because
   * KafkaJS surfaces offsets as strings of arbitrary integer width; we
   * cast in the application layer.
   */
  last_offset: ColumnType<
    bigint | number | string | null,
    bigint | number | string | null | undefined,
    bigint | number | string | null
  >;
  /** Pod / hostname stamped at run registration. NULL on bare runs. */
  host: ColumnType<string | null, string | null | undefined, string | null>;
  /** Short failure summary. Long stack traces belong in logs. */
  error_summary: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * Closed set of `identity_links.confidence` values. Mirrors the
 * `identity_links_confidence_allowed` CHECK constraint in
 * `db/migrations/20260512000010_create_identity_links.sql`.
 *
 * v1 of `processors/identity-resolver/v1/` only emits `authoritative` from
 * the explicit-overlap rule. `candidate` is reserved for future heuristic
 * processors; the default identity-resolver view filters on
 * `confidence = 'authoritative'` so candidate rows never enter the canonical
 * graph.
 */
export type IdentityLinkConfidence = "authoritative" | "candidate";

/**
 * `identity_links` table.
 *
 * Canonical identity graph storage. Each row is one **directional pair**
 * between two identifiers expressed in `<kind>:<value>` form (e.g.
 * `anonymous_id:anon_abc` and `customer_id:cus_123`). The shape is
 * intentionally extensible: `evidence_type` is open-vocabulary text and
 * `evidence` is `jsonb`, so new heuristic rules can be introduced by
 * inserting rows with a new `evidence_type` value plus code that interprets
 * it — no migration required.
 *
 * Schema reference:
 *   db/migrations/20260512000010_create_identity_links.sql
 *
 * Task reference:
 *   docs/implementation/tasks/P8-002-identity-resolver-v1.md
 */
export interface IdentityLinksTable {
  /** UUIDv7 of the link row. Application-generated. */
  link_id: string;
  /** Project scope. References `projects(project_id)`. */
  project_id: string;
  /** Environment scope. Closed set: development | staging | production. */
  environment: string;
  /**
   * Left identifier in `<kind>:<value>` form. Convention: the
   * alphabetically-smaller `kind` is placed left.
   */
  left_identifier: string;
  /** Right identifier in `<kind>:<value>` form. */
  right_identifier: string;
  /**
   * Link-quality marker. v1 emits only `authoritative`; `candidate` is
   * reserved for future heuristic processors. See {@link IdentityLinkConfidence}.
   */
  confidence: ColumnType<
    IdentityLinkConfidence,
    IdentityLinkConfidence | undefined,
    IdentityLinkConfidence
  >;
  /**
   * Open vocabulary identifying which rule produced the link
   * (e.g. `explicit_overlap`, `session_proximity`). New values land without
   * a schema migration.
   */
  evidence_type: string;
  /**
   * Heuristic-specific evidence payload. Shape is per-`evidence_type`; the
   * processor code registry documents expected shapes. `jsonb` so existing
   * rows survive future shape additions.
   */
  evidence: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  /** Human-readable rationale captured at insert time. */
  reason: string;
  /** Emitting processor name (matches the directory under `processors/`). */
  processor_name: string;
  /** Emitting processor version (matches the directory under `processors/<name>/`). */
  processor_version: string;
  /**
   * `processor_runs.run_id` that recorded the link. NULL after the run row
   * is deleted (FK is `ON DELETE SET NULL`) — the audit trail of the link
   * itself stays intact.
   */
  run_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Insertion time, in UTC. Defaults to `now()` server-side. */
  created_at: Generated<Date>;
  /**
   * Retirement marker. NULL while the link is active. Set when a heuristic
   * promotion or operator correction supersedes the row — the row is
   * preserved (no DELETE) for audit purposes.
   */
  superseded_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/**
 * `topic_isolations` table.
 *
 * Per `docs/architecture/03-rabbitmq-streams.md` "Topic Isolation Triggers"
 * and "Topic Families", a project may graduate from a shared canonical
 * topic to a dedicated topic when one of the documented isolation
 * triggers fires. The move is operational, not structural: producer and
 * consumer code continues to reference the logical topic family and
 * consults the resolver in `@polaris/shared-transport` for the concrete
 * topic. This table is the persistent backing store the resolver reads.
 *
 * One row per activation event. `deactivated_at` is NULL while the
 * isolation is active; the resolver only considers rows with
 * `deactivated_at IS NULL`. Deactivated rows accumulate as history so
 * operators can answer "when was family X isolated for project Y?"
 * without consulting the audit log.
 *
 * **PostgreSQL does NOT store the canonical topic family list.** The
 * source of truth for canonical families is the `CANONICAL_STREAM_FAMILIES`
 * constant in `packages/shared-transport/src/streams.ts`; the migration's
 * CHECK constraint mirrors that constant. Widening the set is a
 * coordinated change to the constant AND the migration.
 *
 * Schema reference:
 *   db/migrations/20260514000003_create_topic_isolations.sql
 */
export interface TopicIsolationsTable {
  /** Platform-issued UUIDv7 of the activation event. */
  id: string;
  /** Project the isolation applies to. References `projects(project_id)`. */
  project_id: string;
  /** Environment the isolation is scoped to. */
  environment: string;
  /**
   * Canonical topic family this isolation moves off the shared default.
   * Must be one of the families in `CANONICAL_STREAM_FAMILIES`.
   */
  topic_family: string;
  /**
   * Concrete dedicated topic name. Always `<topic_family>.<project_id>`;
   * materialized in the row so list queries do not re-derive it.
   */
  concrete_topic: string;
  /** Activation timestamp. Server-stamped via `DEFAULT now()`. */
  activated_at: Generated<Date>;
  /**
   * Deactivation timestamp. NULL while the isolation is active; the
   * resolver filters on `deactivated_at IS NULL`.
   */
  deactivated_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Operator-supplied rationale stamped at activation. */
  reason: string;
  /**
   * Free-text actor label captured at activation. Mirrors
   * `processor_activations.last_changed_by`; the authoritative audit
   * actor identity lives in `audit_records`.
   */
  actor_id: string;
  /** Issuance time, in UTC. */
  created_at: Generated<Date>;
  /** Last mutation time, in UTC. Stamped on every UPDATE. */
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * `transport_checkpoints` table.
 *
 * The authoritative resume point for every Polaris stream consumer —
 * what Kafka consumer-group offsets used to be. RabbitMQ streams consumed
 * over AMQP 0-9-1 have no server-side offset store, so a reconnecting
 * consumer must be told where to attach; this table is where it is told
 * from.
 *
 * `last_offset` is the offset of the last **successfully handled**
 * message. Resume attaches at `last_offset + 1`.
 *
 * Schema reference:
 *   db/migrations/20260810000001_create_transport_checkpoints.sql
 */
export interface TransportCheckpointsTable {
  /**
   * Polaris consumer-group identifier (e.g. `sessionizer-v1`). Not an AMQP
   * concept — changing it rewinds the consumer, so it is part of the
   * component's contract.
   */
  group_name: string;
  /** Concrete partition stream, e.g. `raw.events-2`. */
  stream: string;
  /** Logical stream family, e.g. `raw.events`. Derived from `stream`. */
  family: string;
  /** Partition index within the family's super stream. */
  partition: number;
  /**
   * Offset of the last successfully handled message. `bigint` in
   * PostgreSQL; `pg` returns it as a string to avoid precision loss, and
   * writes accept either.
   */
  last_offset: ColumnType<string, bigint | string | number, bigint | string | number>;
  /** Last time the checkpoint advanced. Drives the stalled-consumer query. */
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  created_at: Generated<Date>;
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
  identity_links: IdentityLinksTable;
  processor_activations: ProcessorActivationsTable;
  processor_runs: ProcessorRunsTable;
  projects: ProjectsTable;
  sources: SourcesTable;
  topic_isolations: TopicIsolationsTable;
  transport_checkpoints: TransportCheckpointsTable;
}
