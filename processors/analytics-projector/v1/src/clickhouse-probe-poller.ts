/**
 * Periodic probe poller for ClickHouse health signals.
 *
 * Calls the {@link ClickHouseHealthProbes} surface every
 * {@link CreateClickHouseProbePollerOptions.intervalMs} ms and
 * translates the rows into Polaris gauges via
 * {@link ClickHouseProbeMetrics}. Each iteration clears the previous
 * label tuples for the affected metric so stale views or tables
 * (e.g. a materialized view that was dropped) do not linger at the
 * last observed value.
 *
 * The poller is intentionally tolerant: a probe failure (timeout,
 * permission error, network blip) is logged at `warn` and the next
 * tick proceeds. Three consecutive failures within a 5-minute window
 * are escalated to `error` so on-call has a log signal even when
 * Prometheus is otherwise quiet.
 *
 * The poller does NOT own the ClickHouse client's connection
 * lifecycle; callers connect/close the underlying client themselves.
 */
import type { ClickHouseHealthProbes } from "@polaris/shared-clickhouse";
import type { Logger } from "@polaris/shared-logger";
import {
  type ClickHouseProbeMetrics,
  METRIC_CLICKHOUSE_KAFKA_INGESTION_LAG_SECONDS,
  METRIC_CLICKHOUSE_MV_STATE,
} from "./clickhouse-probe-metrics.js";

export interface CreateClickHouseProbePollerOptions {
  readonly probes: ClickHouseHealthProbes;
  readonly metrics: ClickHouseProbeMetrics;
  readonly logger: Logger;
  /** Poll interval in milliseconds. Defaults to 30_000 (30s). */
  readonly intervalMs?: number;
  /**
   * ClickHouse database to probe. Defaults to `polaris`. The probe
   * helpers default to the same name; surfacing it here makes the
   * config-driven override explicit.
   */
  readonly database?: string;
}

export interface ClickHouseProbePoller {
  /**
   * Start the poller. Idempotent: a second `start()` is a no-op while
   * the first is still running. Returns immediately; the first tick
   * runs on the supplied interval, not synchronously.
   */
  start(): void;
  /**
   * Stop the poller. Idempotent. Awaits the in-flight tick (if any)
   * so callers can rely on no more metric writes happening after the
   * returned promise resolves.
   */
  stop(): Promise<void>;
  /**
   * Run one probe iteration synchronously. Public so the projector can
   * trigger an immediate scrape at startup and so unit tests can drive
   * the poller deterministically without relying on a real timer.
   */
  tick(): Promise<void>;
}

const FAILURE_WINDOW_MS = 5 * 60_000;
const FAILURE_ESCALATE_AT = 3;

export function createClickHouseProbePoller(
  options: CreateClickHouseProbePollerOptions,
): ClickHouseProbePoller {
  const intervalMs = options.intervalMs ?? 30_000;
  const databaseInput = options.database;
  const probeInput = databaseInput !== undefined ? { database: databaseInput } : {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  // Sliding window of recent failure timestamps.
  let recentFailures: number[] = [];

  async function tick(): Promise<void> {
    try {
      const [lagRows, mvRows] = await Promise.all([
        options.probes.kafkaIngestionLag(probeInput),
        options.probes.materializedViewStates(probeInput),
      ]);
      // Clear prior label tuples; only the rows seen on this tick are
      // emitted on the next scrape.
      options.metrics.clear(METRIC_CLICKHOUSE_KAFKA_INGESTION_LAG_SECONDS);
      for (const row of lagRows) {
        options.metrics.observeKafkaIngestionLagSeconds(
          { database: row.database, table: row.table },
          row.lag_seconds,
        );
      }
      options.metrics.clear(METRIC_CLICKHOUSE_MV_STATE);
      for (const row of mvRows) {
        // For each view, emit one sample per *observed* state value
        // with a 1. The alert watches `state="failed"`, so failing
        // views surface a non-zero series; healthy views surface a
        // non-zero `state="running"` (or `state="idle"`) series.
        options.metrics.observeMaterializedViewState(
          { database: row.database, view: row.view, state: row.state },
          1,
        );
      }
      // Successful tick — reset the failure window.
      recentFailures = [];
    } catch (err) {
      const now = Date.now();
      recentFailures = recentFailures.filter((ts) => now - ts < FAILURE_WINDOW_MS);
      recentFailures.push(now);
      const summary = err instanceof Error ? err.message : String(err);
      if (recentFailures.length >= FAILURE_ESCALATE_AT) {
        options.logger.error(
          {
            component: "analytics-projector.clickhouse-probe",
            consecutive_failures: recentFailures.length,
            err_summary: summary,
          },
          "clickhouse probe failed repeatedly; on-call should investigate",
        );
      } else {
        options.logger.warn(
          {
            component: "analytics-projector.clickhouse-probe",
            consecutive_failures: recentFailures.length,
            err_summary: summary,
          },
          "clickhouse probe failed; will retry on next tick",
        );
      }
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      inFlight = tick();
      try {
        await inFlight;
      } finally {
        inFlight = null;
        if (!stopped) schedule();
      }
    }, intervalMs);
  }

  return {
    start(): void {
      if (timer !== null || stopped) return;
      schedule();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight !== null) {
        try {
          await inFlight;
        } catch {
          // Already logged inside tick(); swallow on shutdown.
        }
      }
    },
    tick,
  };
}
