/**
 * @polaris/shared-clickhouse
 *
 * The only sanctioned in-process path to ClickHouse for Polaris services
 * and the CLI. Wraps the official `@clickhouse/client` package and exposes
 * a role-aware surface (service / operator) that mirrors the database-level
 * grants in `db/clickhouse/roles/`.
 *
 * See `docs/architecture/07-clickhouse.md` "Access Control" and
 * `docs/architecture/09-engineering-standards.md` "ClickHouse Access" for
 * the architectural rules this package enforces.
 */

export {
  type ClickHouseClient,
  type ClickHouseClientConfig,
  type ClickHouseClientOptions,
  type ClickHouseOperatorClient,
  type ClickHouseServiceClient,
  type CreateClickHouseClientInput,
  createClickHouseClient,
  createClickHouseClientFromConfig,
} from "./client.js";
export { parseClickHouseConfig } from "./config.js";
export {
  ClickHouseConfigError,
  ClickHouseConnectionError,
  ClickHouseError,
  type ClickHouseErrorCode,
  ClickHouseEscapeHatchUnauthorizedError,
  ClickHouseInvariantError,
  ClickHouseQueryError,
  ClickHouseRoleDeniedError,
} from "./errors.js";
export type { HealthChecker } from "./health.js";
export { INGEST_LOG_TRACE_MAX_LIMIT, type IngestLogReader } from "./ingest-log.js";
export {
  createMergeMapStore,
  MERGE_MAP_TABLE,
  type MergeMapChainEntry,
  type MergeMapRow,
  type MergeMapStore,
} from "./merge-map.js";
export type {
  ClickHouseHealthProbes,
  MaterializedViewStateRow,
  MaterializedViewStatesInput,
  PartsHealthRow,
  PartsSummaryInput,
} from "./probes/index.js";
export {
  buildMaterializedViewStatesSql,
  buildPartsSummarySql,
  createClickHouseHealthProbes,
} from "./probes/index.js";
export type {
  EventDailyCountsReader,
  ProjectionReaders,
  SessionDailyMetricsReader,
} from "./projections/index.js";
export type { OperatorRaw } from "./raw.js";
export { ESCAPE_HATCH_METRIC } from "./raw.js";
// ---------------------------------------------------------------------------
// Rebuild planner (P7-005). Pure functions; no I/O surface of its own — the
// CLI wires the partitions-reader adapter to the operator client.
// ---------------------------------------------------------------------------
export type {
  ClickhouseProjectionDescriptor,
  ClickhouseRebuildDeclaration,
  ClickhouseRebuildPlan,
  ClickhouseRebuildPlanned,
  ClickhouseRebuildRejected,
  ClickhouseRebuildRejectionCode,
  PartsSummary,
  PlanClickhouseRebuildOptions,
} from "./rebuild/index.js";
export {
  CLICKHOUSE_REBUILD_REJECTION_CODES,
  findRebuildableProjection,
  planClickhouseRebuild,
  REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES,
  REBUILDABLE_CLICKHOUSE_PROJECTIONS,
  renderClickhouseRebuildPlanHuman,
} from "./rebuild/index.js";
export type { ReplayReader } from "./replay.js";
export {
  ANALYTICS_PROCESSED_QUEUE_TABLE,
  ANALYTICS_QUEUE_TABLE,
  type AnalyticsQueueRow,
  type AnalyticsSinkWriter,
  type CreateAnalyticsSinkWriterInput,
  createAnalyticsSinkWriter,
  PROFILE_EVENTS_QUEUE_TABLE,
  type ProfileEventQueueRow,
  VIOLATIONS_QUEUE_TABLE,
  type ViolationQueueRow,
} from "./sink.js";
export {
  createTraitQueryReader,
  type TraitQueryReader,
  type TraitQueryRow,
} from "./traits.js";
export type {
  AnalyticsIngestLogRow,
  AnalyticsProcessedRow,
  AnalyticsRawRow,
  ArgMaxByEventKeyFilter,
  ClickHouseCredential,
  ClickHouseRole,
  CountDistinctEventsFilter,
  CredentialRef,
  EventDailyCountRow,
  EventDailyCountsFilter,
  EventKey,
  HealthCheckResult,
  IngestLogFilter,
  IngestLogTraceFilter,
  IngestLogTraceRow,
  Logger,
  MetricsRecorder,
  RawQueryContext,
  RawQueryResult,
  SessionDailyMetricRow,
  SessionDailyMetricsFilter,
  TimeRange,
} from "./types.js";
export { buildClickHouseVersion, type ClickHouseVersionStage } from "./version.js";
export {
  createViolationReader,
  type ListViolationsFilter,
  VIOLATIONS_MAX_LIMIT,
  type ViolationReader,
  type ViolationRow,
  type ViolationSummaryRow,
} from "./violations.js";
export {
  createWarehouseExporter,
  isWarehouseDataset,
  WAREHOUSE_DATASETS,
  type WarehouseDataset,
  type WarehouseExporter,
  type WarehouseExportRequest,
  type WarehouseExportResult,
  type WarehouseExportTarget,
} from "./warehouse-export.js";
