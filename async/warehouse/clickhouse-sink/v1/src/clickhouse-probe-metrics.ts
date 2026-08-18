/**
 * ClickHouse-probe metrics emitted by the clickhouse-sink.
 *
 * The architecture forbids querying the ingestion interface table
 * directly (see `docs/architecture/07-clickhouse.md`); the
 * canonical-consumer pattern is that the clickhouse-sink — which owns
 * the ClickHouse side of analytics ingestion since 126EPNIQ retired the
 * analytics-projector — polls
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
 * The registry intentionally lives next to the canonical consumer
 * (rather than in `@polaris/shared-clickhouse`) because the metrics
 * surface is a property of that consumer, not the ClickHouse client
 * library — there is no second consumer, and pulling these into a shared
 * library would suggest otherwise. That reasoning is why this moved here
 * with the retirement rather than being deleted alongside the projector.
 *
 * ## KNOWN BROKEN, and not by this move
 *
 * `polaris_clickhouse_mv_state` has never carried a value.
 * `buildMaterializedViewStatesSql` reads `system.view_refreshes`, which
 * tracks REFRESHABLE materialized views only; all nine of Polaris's are
 * plain insert-triggered MVs and never appear there. The query also names
 * columns that table does not have (`name`, `last_exception` — they are
 * `view` and `exception`), so it errors before returning the zero rows it
 * would otherwise get.
 *
 * So `PolarisClickHouseMVFailure` has never been able to fire, over the
 * MV layer that several 2026-08 data-loss bugs flowed straight through.
 * Fixing it means picking a signal that plain MVs actually emit — their
 * failures surface as exceptions in `system.query_log` against the inner
 * query — which is a monitoring design decision, not a typo fix, and is
 * left for one.
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
