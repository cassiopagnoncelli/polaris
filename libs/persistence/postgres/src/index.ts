/**
 * @polaris/persistence-postgres
 *
 * Polaris's sanctioned PostgreSQL access layer.
 *
 * Polaris is file-heavy and database-light. PostgreSQL stores only mutable
 * runtime/control state (api_keys, sources, destination_instances,
 * processor_runs, replay_jobs, delivery_records, audit_records,
 * operator_tokens, topic_isolations, identity_links). Semantic platform
 * truth lives in versioned code, not in PostgreSQL.
 *
 * Two surfaces are exported from this package:
 *
 *   1. The `Database` interface (in ./database.ts) — the Kysely-typed view
 *      of every table the control plane owns. It is intentionally empty
 *      today. Each table-owning task (P6-*, P7-*, P9-*, P11-*) extends it
 *      when it lands its migration.
 *
 *   2. `createDb(...)` — a factory that builds a `Kysely<Database>` over a
 *      `pg` connection pool. Services and CLI commands import this rather
 *      than constructing a Kysely instance themselves; that keeps pool
 *      lifecycle and SQL dialect consistent across the platform.
 *
 * Schema is the migrations' source of truth — never this file. When a new
 * table lands, extend `Database` and let `tsc` find the call sites that
 * need to handle the new shape.
 */

export type {
  CreateDbOptions,
  Database,
  PostgresConnectionConfig,
} from "./client.js";
export { closeDb, createDb, postgresConnectionString } from "./client.js";
export type {
  AttributionTouchpointChainsTable,
  AudienceMembershipsTable,
  DestinationMode,
  DestinationRetryPolicy,
  DestinationStatus,
  DestinationsTable,
  Environment,
  IdentityLinkConfidence,
  IdentityLinksTable,
  JourneyParticipantsTable,
  ProcessorActivationState,
  ProcessorActivationsTable,
  ProcessorRunStatus,
  ProcessorRunsTable,
  ProjectStatus,
  ProjectsTable,
  SourceRuntime,
  SourceStatus,
  SourcesTable,
  SourceType,
  TopicIsolationsTable,
  TransportCheckpointsTable,
} from "./database.js";
