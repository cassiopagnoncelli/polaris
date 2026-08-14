/**
 * ClickHouse-probe metrics emitted by the analytics-projector.
 *
 * The architecture forbids querying the ingestion interface table
 * directly (see `docs/architecture/07-clickhouse.md`); the
 * canonical-consumer pattern is that the analytics-projector — which
 * already owns the ClickHouse side of analytics ingestion — polls
 * `system.*` views on a schedule and re-publishes their state as
 * Polaris Prometheus gauges. One alert gates on these gauges:
 *
 *   - `PolarisClickHouseMVFailure` — driven by
 *     `polaris_clickhouse_mv_state{view, state}` matching `state="failed"`.
 *
 * The ingestion-lag gauge that used to live here
 * (`polaris_clickhouse_kafka_ingestion_lag_seconds`, derived from
 * `system.kafka_consumers`) is gone. ClickHouse consumes nothing since
 * the RabbitMQ migration, so that system table is permanently empty and
 * the gauge would have reported a confident zero forever — the worst
 * possible failure mode for a lag signal. `async/warehouse/clickhouse-sink`
 * emits `polaris_clickhouse_sink_lag_seconds` instead, and the alerts
 * point at that.
 *
 * The registry intentionally lives next to the analytics-projector
 * (rather than in `@polaris/shared-clickhouse`) because the metrics
 * surface is a property of the canonical consumer, not the
 * ClickHouse client library — there is no second consumer in v1, and
 * pulling these into a shared library would suggest otherwise.
 */
import type { MetricSample } from "@polaris/shared-metrics";

/**
 * Per-(view, state) gauge for materialized-view state. The alert layer
 * watches `state="failed"`; intermediate states (`idle`, `running`)
 * are emitted as zero so dashboards can still chart them by switching
 * the legend.
 */
export const METRIC_CLICKHOUSE_MV_STATE = "polaris_clickhouse_mv_state";

export interface MaterializedViewStateLabels {
  readonly database: string;
  readonly view: string;
  readonly state: string;
}

/**
 * In-process gauge registry for the probe metrics. Mirrors the shape of
 * `IngestMetrics` / `ProcessorMetrics`: a tiny in-memory map keyed by a
 * deterministic label-tuple string, with `getSamples()` emitting the
 * shape the `/metrics` endpoint serialiser consumes.
 *
 * The registry is intentionally NOT thread-safe — Node's single-threaded
 * event loop makes the simple Map assignment safe across awaits, and
 * the projector's poller runs on its own interval timer so there is no
 * concurrent writer.
 */
export class ClickHouseProbeMetrics {
  private readonly samples = new Map<string, MetricSample>();

  observeMaterializedViewState(labels: MaterializedViewStateLabels, value: number): void {
    const labelRecord = {
      database: labels.database,
      view: labels.view,
      state: labels.state,
    };
    this.set(METRIC_CLICKHOUSE_MV_STATE, labelRecord, value);
  }

  /**
   * Clear all samples for a base metric name. Used by the poller so
   * stale tuples (e.g. a materialized view that no longer exists)
   * disappear from the next scrape rather than ticking at a stale
   * value forever.
   */
  clear(name: string): void {
    for (const key of [...this.samples.keys()]) {
      if (key.startsWith(`${name}|`)) {
        this.samples.delete(key);
      }
    }
  }

  getSamples(): MetricSample[] {
    return Array.from(this.samples.values()).map((sample) => ({
      name: sample.name,
      labels: { ...sample.labels },
      value: sample.value,
    }));
  }

  reset(): void {
    this.samples.clear();
  }

  private set(
    name: string,
    labels: Readonly<Record<string, string | number>>,
    value: number,
  ): void {
    const key = sampleKey(name, labels);
    this.samples.set(key, { name, labels: { ...labels }, value });
  }
}

function sampleKey(name: string, labels: Readonly<Record<string, string | number>>): string {
  const keys = Object.keys(labels).sort();
  const parts = keys.map((k) => `${k}=${labels[k]}`);
  return `${name}|${parts.join(",")}`;
}
