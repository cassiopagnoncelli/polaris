/**
 * Standard log fields used across Polaris services.
 *
 * The full list is defined in `docs/architecture/08-observability-and-operations.md`
 * under "Standard Log Fields". Every field is optional on individual log lines
 * — services attach the fields that make sense for their context (request,
 * source, processor, consumer, replay job, destination) through child loggers.
 *
 * Field names match the canonical event envelope where applicable
 * (`event_id`, `project_id`, `environment`) so log lines join naturally
 * against `analytics_raw` projections in ClickHouse.
 */
export interface StandardLogFields {
  /** Canonical event identifier (UUIDv7). */
  event_id?: string;
  /** Logical project owner. First-class scoping field on every event/log. */
  project_id?: string;
  /** Deployment environment stamped by the ingester from the API key. */
  environment?: string;
  /** Source identifier stamped by the ingester (e.g. `payments-api`). */
  source_id?: string;
  /** Redpanda topic name (e.g. `raw.events`, `analytics.events`). */
  topic?: string;
  /** Redpanda partition number. */
  partition?: number;
  /** Redpanda message offset. */
  offset?: string | number;
  /** Processor name from the immutable version directory. */
  processor_name?: string;
  /** Processor version string (e.g. `v1`). */
  processor_version?: string;
  /** Destination consumer name. */
  consumer_name?: string;
  /** Destination consumer version string. */
  consumer_version?: string;
  /** Replay job identifier (UUIDv7). */
  replay_job_id?: string;
  /** Destination instance identifier. */
  destination_id?: string;
  /** Per-request trace identifier (UUIDv7). */
  request_id?: string;
  /**
   * Pipeline release label stamped at build time (e.g. `2026-q2-r1`).
   * Bound by `createLogger` on every line so a rollout can be filtered in
   * Loki/Grafana without each service wiring it manually. See P11-007 and
   * `docs/deployment/versioning.md`.
   */
  release_label?: string;
}

/**
 * Standard log levels supported by the Polaris logger.
 *
 * Matches Pino's default level set. `trace` and `debug` are gated to
 * non-production environments unless explicitly enabled by config.
 */
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

/**
 * Per-service identity attached to every log line as bindings.
 *
 * `service` is required so logs from different services in the same Loki
 * stream are trivially separable. The other fields are recommended but
 * optional; they roll up under the same `service` umbrella for an instance.
 */
export interface ServiceBinding {
  /** Service name (kebab-case, e.g. `ingester-api`, `sessionizer-v1`). */
  service: string;
  /** Package version stamped at build time (e.g. `1.2.3`, `0.0.0-dev`). */
  version?: string;
  /** Deployment environment label — `local`, `dev`, `staging`, `production`. */
  env?: string;
  /** Hostname or pod name. Default: `os.hostname()`. */
  hostname?: string;
  /** Free-form region or zone label, useful for multi-region rollouts. */
  region?: string;
  /**
   * Optional human-readable pipeline release label (e.g. `2026-q2-r1`).
   * Distinct from `version` (which is the package version): the release
   * label scopes a rollout that bundles many services. Surfaced as
   * `release_label` in every log line. See `docs/deployment/versioning.md`.
   */
  releaseLabel?: string;
}

/**
 * Options for `createLogger`.
 */
export interface LoggerOptions {
  /** Service binding fields attached to every log line. */
  service: string;
  /** Package version (e.g. `1.2.3`, `0.0.0-dev`). */
  version?: string;
  /** Deployment environment label. */
  env?: string;
  /** Hostname or pod name override. */
  hostname?: string;
  /** Free-form region label. */
  region?: string;
  /**
   * Optional pipeline release label, stamped as `release_label` on every
   * log line. See {@link ServiceBinding.releaseLabel}.
   */
  releaseLabel?: string;
  /** Initial log level. Default: `info`. */
  level?: LogLevel;
  /**
   * Additional redaction paths appended to the platform defaults.
   * The default list cannot be narrowed — callers can only extend it.
   */
  additionalRedactionPaths?: readonly string[];
  /**
   * Stable bindings attached to every log line in addition to the service
   * identity. Useful for cluster-wide labels (`cluster`, `tenant_slot`).
   */
  bindings?: Record<string, unknown>;
  /**
   * Stream destination override. Default: `process.stdout`.
   *
   * Production must keep the default JSON-to-stdout behaviour. Test code
   * passes a captured stream so assertions can inspect serialised output.
   */
  destination?: NodeJS.WritableStream;
  /**
   * Override the wall-clock timestamp function. Default: ISO-8601 UTC.
   *
   * Tests pin this to a deterministic value; production should never set it.
   */
  timeFn?: () => string;
}
