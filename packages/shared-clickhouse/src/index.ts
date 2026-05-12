/**
 * @polaris/shared-clickhouse
 *
 * The only sanctioned in-process path to ClickHouse for Polaris services
 * and the CLI. Wraps the official `@clickhouse/client` package and exposes
 * a role-aware surface (service / operator) that mirrors the database-level
 * grants in `sql/clickhouse/roles/`.
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
export type { IngestLogReader } from "./ingest-log.js";
export type {
  EventDailyCountsReader,
  ProjectionReaders,
} from "./projections/index.js";
export type { OperatorRaw } from "./raw.js";
export { ESCAPE_HATCH_METRIC } from "./raw.js";
export type { ReplayReader } from "./replay.js";
export type {
  AnalyticsIngestLogRow,
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
  Logger,
  MetricsRecorder,
  RawQueryContext,
  RawQueryResult,
  TimeRange,
} from "./types.js";
