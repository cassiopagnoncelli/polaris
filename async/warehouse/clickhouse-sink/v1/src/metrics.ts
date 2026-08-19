/**
 * In-process metrics for the ClickHouse sink.
 *
 * Follows the `ProcessorMetrics` / `IngestMetrics` pattern: a small
 * in-memory registry with bounded label cardinality, exposed through
 * `getSamples()` for the `/metrics` endpoint.
 *
 * `polaris_clickhouse_sink_lag_seconds` is the metric that matters
 * operationally. It replaces the ClickHouse-internal Kafka-engine lag the
 * alert rules used to watch — that signal disappeared with the engine, and
 * an alert that silently stops firing is worse than no alert, so this one
 * is emitted from the very first message the sink handles.
 *
 * Every series carries a `table` label naming the ingestion interface
 * table the rows were routed to. The label is what makes the source and
 * derived ingestion paths independently observable: they share a process,
 * a connection and a batch timer, but they can lag, stall and fail
 * separately. `max by (table)` in the alert rules means both paths are
 * covered by the rules that already exist.
 *
 * @see docs/operations/runbook-clickhouse-ingestion-lag.md
 * @see infra/prometheus/rules/polaris.alerts.yml
 */

import {
  ANALYTICS_PROCESSED_QUEUE_TABLE,
  ANALYTICS_QUEUE_TABLE,
  PROFILE_EVENTS_QUEUE_TABLE,
  VIOLATIONS_QUEUE_TABLE,
} from "@polaris/shared-clickhouse";
import type { MetricSample } from "@polaris/shared-metrics";

export const METRIC_SINK_ROWS_CONSUMED_TOTAL = "polaris_clickhouse_sink_rows_consumed_total";
export const METRIC_SINK_ROWS_SKIPPED_TOTAL = "polaris_clickhouse_sink_rows_skipped_total";
export const METRIC_SINK_BATCHES_TOTAL = "polaris_clickhouse_sink_batches_total";
export const METRIC_SINK_BATCH_ROWS_LAST = "polaris_clickhouse_sink_batch_rows_last";
export const METRIC_SINK_INSERT_DURATION_MS_LAST =
  "polaris_clickhouse_sink_insert_duration_ms_last";
/**
 * Batches whose INSERT was rejected by ClickHouse, by table.
 *
 * This is the materialized-view failure signal. Polaris's nine MVs are
 * plain insert-triggered views and `materialized_views_ignore_errors` is
 * 0, so an MV whose SELECT throws fails the WHOLE INSERT -- the exception
 * comes back to this process. There is no separate "MV in a failed state"
 * to poll; that concept belongs to refreshable MVs, which Polaris has
 * none of.
 *
 * A probe polling `system.view_refreshes` for that non-existent state is
 * what `PolarisClickHouseMVFailure` used to read, and it never once
 * produced a value. Counting the failures where they actually surface is
 * the honest replacement.
 */
export const METRIC_SINK_INSERT_FAILURES_TOTAL = "polaris_clickhouse_sink_insert_failures_total";
/** Ingestion lag in seconds: now − the envelope's `ingested_at`. */
export const METRIC_SINK_LAG_SECONDS = "polaris_clickhouse_sink_lag_seconds";

/**
 * The ingestion interface tables the sink routes between.
 *
 * Four, not three. `violations_queue` was missing while `recordBatch` was
 * already being called with it, so the quarantine's lag gauge was never
 * seeded -- and an unseeded lag series is exactly what the comment on
 * `#lagSeconds` says must not happen, since its absence and healthy
 * silence look identical.
 */
const SINK_TABLES = [
  ANALYTICS_QUEUE_TABLE,
  ANALYTICS_PROCESSED_QUEUE_TABLE,
  PROFILE_EVENTS_QUEUE_TABLE,
  VIOLATIONS_QUEUE_TABLE,
] as const;

export class SinkMetrics {
  #consumed = new Map<string, number>();
  #skipped = 0;
  #batches = new Map<string, number>();
  #batchRowsLast = new Map<string, number>();
  #insertDurationMsLast = new Map<string, number>();
  /**
   * Seeded at zero for the same reason as the lag gauge below: an alert on
   * `increase(...) > 0` needs the series to exist before the first
   * failure, or the first failure and a scrape gap look alike.
   */
  #insertFailures = new Map<string, number>(SINK_TABLES.map((table) => [table, 0]));
  /**
   * Seeded with both tables at zero rather than filled on first use. A
   * series that only appears once a row arrives is a series whose absence
   * looks identical to healthy silence — and the lag alert is exactly the
   * thing that must not go quiet when a path stops receiving.
   */
  #lagSeconds = new Map<string, number>(SINK_TABLES.map((table) => [table, 0]));

  recordConsumed(projectId: string, environment: string, table: string): void {
    const key = `${projectId} ${environment} ${table}`;
    this.#consumed.set(key, (this.#consumed.get(key) ?? 0) + 1);
  }

  recordSkipped(): void {
    this.#skipped += 1;
  }

  recordInsertFailure(table: string): void {
    this.#insertFailures.set(table, (this.#insertFailures.get(table) ?? 0) + 1);
  }

  recordBatch(rows: number, durationMs: number, table: string): void {
    this.#batches.set(table, (this.#batches.get(table) ?? 0) + 1);
    this.#batchRowsLast.set(table, rows);
    this.#insertDurationMsLast.set(table, durationMs);
  }

  /**
   * Record ingestion lag from the envelope's `ingested_at`. An unparsable
   * timestamp is ignored rather than recorded as a huge lag, which would
   * page someone for a malformed message.
   */
  recordLag(ingestedAt: string, nowMs: number, table: string): void {
    const parsed = Date.parse(ingestedAt);
    if (Number.isNaN(parsed)) return;
    this.#lagSeconds.set(table, Math.max(0, (nowMs - parsed) / 1000));
  }

  getSamples(): ReadonlyArray<MetricSample> {
    const samples: MetricSample[] = [];
    for (const [key, value] of this.#consumed) {
      const [projectId = "", environment = "", table = ""] = key.split(" ");
      samples.push({
        name: METRIC_SINK_ROWS_CONSUMED_TOTAL,
        labels: { project_id: projectId, environment, table },
        value,
      });
    }
    samples.push({ name: METRIC_SINK_ROWS_SKIPPED_TOTAL, labels: {}, value: this.#skipped });
    for (const table of SINK_TABLES) {
      samples.push({
        name: METRIC_SINK_BATCHES_TOTAL,
        labels: { table },
        value: this.#batches.get(table) ?? 0,
      });
      samples.push({
        name: METRIC_SINK_BATCH_ROWS_LAST,
        labels: { table },
        value: this.#batchRowsLast.get(table) ?? 0,
      });
      samples.push({
        name: METRIC_SINK_INSERT_DURATION_MS_LAST,
        labels: { table },
        value: this.#insertDurationMsLast.get(table) ?? 0,
      });
      samples.push({
        name: METRIC_SINK_INSERT_FAILURES_TOTAL,
        labels: { table },
        value: this.#insertFailures.get(table) ?? 0,
      });
      samples.push({
        name: METRIC_SINK_LAG_SECONDS,
        labels: { table },
        value: this.#lagSeconds.get(table) ?? 0,
      });
    }
    return samples;
  }
}
