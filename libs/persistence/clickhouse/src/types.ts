/**
 * Public type surface for @polaris/persistence-clickhouse.
 *
 * These types are intentionally narrow. They describe just enough of the
 * Pino logger and the metrics recorder for this package to compose with the
 * rest of the workspace without taking a hard dependency on a particular
 * Pino/Prometheus client version.
 *
 * Once `@polaris/observability-logger` (P0-004) and the metrics convention
 * (P10-002) land, those packages will satisfy these interfaces. Until then,
 * services can pass any logger/metrics object that conforms to the shape.
 */

export type ClickHouseRole = "service" | "operator";

/**
 * Minimal Pino-shaped logger. The `child(...)` method is used to attach
 * persistent context (e.g. role, requestId) to all log lines emitted from a
 * given client instance.
 */
export interface Logger {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Minimal metrics recorder. Mirrors a Prometheus counter without taking a
 * dependency on prom-client directly. P10-002 will provide a standard
 * implementation; until then, services pass their own.
 */
export interface MetricsRecorder {
  incrementCounter(name: string, labels?: Record<string, string>, value?: number): void;
}

/**
 * Credential carried by the config object. The credential is read from the
 * secret provider at config-build time, not stored in version control.
 * Username MUST match the declared role: `polaris_service` for `service`,
 * `polaris_operator` for `operator`.
 */
export interface ClickHouseCredential {
  username: string;
  password: string;
}

/**
 * Reference to a credential held in the secret provider. Resolved before the
 * client is constructed; this package never reads `process.env` directly.
 */
export interface CredentialRef {
  /** Secret provider identifier (e.g. `env:CLICKHOUSE_PASSWORD`, `vault:polaris/clickhouse/service`). */
  ref: string;
}

/**
 * Time range filter used by projection and ingest-log readers.
 *
 * `from` / `to` are ISO 8601 UTC strings. The package accepts strings rather
 * than Date objects so callers can pass dates parsed from request bodies
 * without timezone foot-guns.
 */
export interface TimeRange {
  from: string;
  to?: string;
}

/**
 * Stable identity key for a single canonical event row in `analytics_raw`.
 * Matches the ORDER BY of the table and the GROUP BY used by the argMax
 * dedupe pattern in materialized views.
 */
export interface EventKey {
  projectId: string;
  environment: string;
  event: string;
  eventId: string;
}

/**
 * Filter for `replay.argMaxByEventKey`. The caller supplies a bounded list of
 * `eventIds`; this is intentional — the package will not return all rows in a
 * partition. Operators who need open-ended scans go through
 * `operator.raw.query`, which leaves an audit trail.
 */
export interface ArgMaxByEventKeyFilter {
  projectId: string;
  environment: string;
  event: string;
  eventIds: readonly string[];
}

/**
 * Filter for `replay.countDistinctEvents`. Date range is required so
 * callers cannot accidentally scan the entire retention window.
 */
export interface CountDistinctEventsFilter {
  projectId: string;
  environment: string;
  event?: string;
  occurredFrom: string;
  occurredTo: string;
}

/**
 * Row shape returned from a deduped `analytics_raw` read. Columns mirror the
 * physical schema defined in `db/clickhouse/30_analytics_raw.sql`.
 */
export interface AnalyticsRawRow {
  event_id: string;
  event: string;
  schema_version: number;
  project_id: string;
  environment: string;
  occurred_at: string;
  ingested_at: string;
  source_id: string;
  source_type: string;
  sdk: string;
  sdk_version: string;
  anonymous_id: string;
  session_id: string;
  customer_id: string;
  device_id: string;
  ip: string;
  user_agent: string;
  locale: string;
  properties_json: string;
  context_json: string;
  consent_json: string;
  privacy_json: string;
  processor_name: string;
  processor_version: string;
  _version: number | string;
}

/**
 * Row shape returned from a deduped `analytics_processed` read. Columns
 * mirror `db/clickhouse/32_analytics_processed.sql`.
 *
 * Deliberately not `AnalyticsRawRow`: the derived table carries transport
 * lineage (`_topic`, `_partition`, `_offset`) because it has no ingest
 * log behind it, and it omits `sdk` / `sdk_version` / `ip` / `user_agent`
 * / `locale`, which are structurally absent on processor-emitted
 * envelopes. Sharing one type would hand callers columns that are always
 * empty and hide the ones that are not.
 */
export interface AnalyticsProcessedRow {
  event_id: string;
  event: string;
  schema_version: number;
  project_id: string;
  environment: string;
  occurred_at: string;
  ingested_at: string;
  source_id: string;
  source_type: string;
  anonymous_id: string;
  session_id: string;
  customer_id: string;
  device_id: string;
  properties_json: string;
  context_json: string;
  consent_json: string;
  privacy_json: string;
  processor_name: string;
  processor_version: string;
  _version: number | string;
  _topic: string;
  _partition: number;
  _offset: number | string;
}

/**
 * Row shape returned from `analytics_ingest_log` reads.
 */
export interface AnalyticsIngestLogRow {
  event_id: string;
  event: string;
  schema_version: number;
  project_id: string;
  environment: string;
  occurred_at: string;
  ingested_at: string;
  _consumed_at: string;
  _topic: string;
  _partition: number;
  _offset: number | string;
}

/**
 * One `analytics_ingest_log` row as `ingestLog.trace` returns it.
 *
 * Widens `AnalyticsIngestLogRow` with the processor stamp columns.
 * `inspect` deliberately does not select them — it answers "what is
 * arriving", where the stamps are noise — while a trace answers "what
 * happened to THIS event", where they are the point: they name which
 * processor wrote the row, so a duplicate event_id from two feeds is
 * legible instead of confusing.
 */
export interface IngestLogTraceRow extends AnalyticsIngestLogRow {
  processor_name: string;
  processor_version: string;
}

/**
 * Filter for `ingestLog.trace`. `eventId` is required — a trace is
 * always about one event — and `projectId` is required because the
 * table's ORDER BY leads with it, so omitting it turns a key lookup into
 * a full scan of the retention window.
 */
export interface IngestLogTraceFilter {
  eventId: string;
  projectId: string;
  environment?: string;
  limit?: number;
}

/**
 * Filter for `ingestLog.inspect`. Defaults to recent rows for a single
 * project; callers can widen by passing `event` or extending the range.
 */
export interface IngestLogFilter {
  projectId: string;
  environment?: string;
  event?: string;
  eventId?: string;
  ingestedFrom?: string;
  ingestedTo?: string;
  limit?: number;
}

/**
 * Row shape for `event_daily_counts`. Mirrors the projection in
 * `db/clickhouse/projections/40_event_daily_counts.sql`.
 */
export interface EventDailyCountRow {
  project_id: string;
  environment: string;
  event: string;
  occurred_date: string;
  event_count: number | string;
}

/**
 * Filter for `projections.eventDailyCounts.read`.
 */
export interface EventDailyCountsFilter {
  projectId: string;
  environment?: string;
  event?: string;
  fromDate: string;
  toDate?: string;
  limit?: number;
}

/**
 * Row shape returned from `projections.sessionDailyMetrics.read`.
 *
 * Counts come back as strings for the same reason `event_count` does:
 * ClickHouse emits UInt64 as JSON strings past 2^53, and coercing here
 * would be lossy.
 */
export interface SessionDailyMetricRow {
  project_id: string;
  environment: string;
  occurred_date: string;
  sessions_started: number | string;
  sessions_ended: number | string;
}

/**
 * Filter for `projections.sessionDailyMetrics.read`.
 *
 * No `event` field, unlike {@link EventDailyCountsFilter}: the event name
 * is encoded by which counter a row contributes to.
 */
export interface SessionDailyMetricsFilter {
  projectId: string;
  environment?: string;
  fromDate: string;
  toDate?: string;
  limit?: number;
}

/**
 * Health-check result. Mirrors the contract used by the workspace's standard
 * `/healthz` and `/readyz` route helpers.
 */
export interface HealthCheckResult {
  healthy: boolean;
  serverVersion?: string;
  latencyMs?: number;
  error?: string;
}

/**
 * Per-call metadata required when invoking the operator escape hatch.
 *
 * `reason` is a short free-form string captured in logs and metrics so
 * reviewers can see why an operator reached for raw SQL. It is NOT a label
 * cardinality risk because we only emit `reason` in the structured log,
 * not in the metric labels.
 */
export interface RawQueryContext {
  /** Caller-supplied identifier (e.g. CLI command name) for log correlation. */
  caller: string;
  /** Short human reason for the escape-hatch call. */
  reason: string;
  /** Optional ticket/incident reference. */
  ticket?: string;
  /**
   * Optional `query_id` forwarded to ClickHouse. When set, ClickHouse
   * tags the query with this id in `system.query_log` so callers can
   * look up `written_rows` / `read_rows` for INSERTs that don't
   * return rows in their response body. Must be unique per
   * concurrent query (ClickHouse rejects duplicates within a window).
   * When omitted, ClickHouse generates one server-side.
   */
  queryId?: string;
}

/**
 * Result of an escape-hatch query.
 */
export interface RawQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  rowCount: number;
  /** Echo back the query for audit-log review. */
  query: string;
}
