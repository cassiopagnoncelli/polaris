/**
 * In-process processor metrics.
 *
 * Mirrors the `IngestMetrics` pattern in `apps/ingester-api`: a tiny
 * in-memory counter/histogram registry that:
 *
 *   - gives the processor runtime a deterministic sink for unit tests,
 *   - keeps the call sites in shape for the future Prometheus migration
 *     (P10-002 swaps the implementation, not the API surface).
 *
 * The registry never stores raw event values. It stores label tuples
 * (processor_name, processor_version, project_id, environment, ...) and
 * per-tuple counters / lag observations.
 *
 * Label cardinality is bounded by the processor count × project count ×
 * environment count, plus the small set of outcomes (`consumed`, `emitted`,
 * `failed`, `dlq`).
 *
 * **Latency histograms (CSH8YAL6).** Each `_ms_last` gauge has a histogram
 * sibling under the `*_seconds` name (Prometheus convention: observe in
 * seconds). Buckets are chosen against
 * `docs/operations/slos.md`: the end-to-end raw→analytics SLO is 60s p99,
 * so the lag histogram spans 100ms–300s; the per-message handler
 * duration histogram spans 1ms–5s. The `_ms_last` gauges are intentionally
 * kept in place so existing dashboards don't go dark during the
 * transition. `getSamples()` emits both. The histogram samples follow the
 * Prometheus exposition shape: `<name>_bucket{le="..."}`, `<name>_sum`,
 * `<name>_count`; `histogram_quantile()` in Grafana works on the bucket
 * series directly.
 *
 * @see apps/ingester-api/src/metrics/registry.ts (IngestMetrics)
 * @see docs/architecture/08-observability-and-operations.md
 * @see docs/operations/slos.md
 */

/** Stable metric names emitted by processor runtimes. */
export const METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL = "polaris_processor_events_consumed_total";
export const METRIC_PROCESSOR_EVENTS_EMITTED_TOTAL = "polaris_processor_events_emitted_total";
export const METRIC_PROCESSOR_EVENTS_FAILED_TOTAL = "polaris_processor_events_failed_total";
export const METRIC_PROCESSOR_EVENTS_DLQ_TOTAL = "polaris_processor_events_dlq_total";
export const METRIC_PROCESSOR_EVENTS_RETRY_TOTAL = "polaris_processor_events_retry_total";
/**
 * Events a processor deliberately did not act on, by `reason`.
 *
 * A skip is a normal outcome, not a failure: the message is acknowledged and
 * nothing is emitted. `reason="processor_disabled"` is the activation gate
 * refusing a (project, environment) an operator switched off. Counted rather
 * than silent so "the pipeline stopped for this project" is answerable from
 * the dashboards, and deliberately separate from the failure/DLQ counters so
 * an operator decision never pages anyone.
 */
export const METRIC_PROCESSOR_EVENTS_SKIPPED_TOTAL = "polaris_processor_events_skipped_total";
export const METRIC_PROCESSOR_LAG_MS_LAST = "polaris_processor_lag_ms_last";
export const METRIC_PROCESSOR_HANDLER_DURATION_MS_LAST =
  "polaris_processor_handler_duration_ms_last";

/**
 * Histogram base name for processor lag (siblings to
 * `polaris_processor_lag_ms_last`). Observations are in **seconds**. The
 * registry emits three series families:
 *
 *   - `polaris_processor_lag_seconds_bucket{le="..."}`
 *   - `polaris_processor_lag_seconds_sum`
 *   - `polaris_processor_lag_seconds_count`
 */
export const METRIC_PROCESSOR_LAG_SECONDS = "polaris_processor_lag_seconds";

/**
 * Histogram base name for per-message handler duration. Same three-family
 * emission as `METRIC_PROCESSOR_LAG_SECONDS`.
 */
export const METRIC_PROCESSOR_HANDLER_DURATION_SECONDS =
  "polaris_processor_handler_duration_seconds";

/**
 * Bucket boundaries (seconds, upper-inclusive) for `polaris_processor_lag_seconds`.
 *
 * Sized against the end-to-end raw→analytics SLO (60s p99 — see
 * `docs/operations/slos.md`). The buckets span well below and well above
 * the SLO so the panel surfaces both healthy and saturated regimes.
 */
export const PROCESSOR_LAG_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
]);

/**
 * Bucket boundaries (seconds, upper-inclusive) for
 * `polaris_processor_handler_duration_seconds`. The per-message handler is
 * expected to be sub-100ms in the common case; the 5s upper bound
 * accommodates outliers (catalog cache rehydrate, slow GeoIP lookup).
 */
export const PROCESSOR_HANDLER_DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5,
]);

/**
 * Label tuple every processor metric carries. The processor `(name,
 * version)` is the immutable identity; `(project_id, environment)` is the
 * per-event scope and is optional because some processors (sessionizer,
 * geoip-enricher) operate cross-project.
 *
 * **Topic-family labels (P11-008).** All metrics emitted by a runtime
 * that touches RabbitMQ MUST carry the topic-family triple
 * (`topic_family`, `concrete_topic`, `partition`) in addition to
 * `(project_id, environment)`. These labels make the per-project
 * isolation dashboards work without a code change: a single Prometheus
 * query like `sum by (project_id) (rate(...{topic_family="raw.events"}))`
 * returns the per-project share of shared-topic throughput. The
 * fields are optional on the type because some processors (control-plane
 * jobs, manifest validators) do not touch RabbitMQ at all; the
 * architecture rule from `docs/architecture/03-rabbitmq-streams.md`
 * "Per-Project Observability" is: every RabbitMQ-touching emission
 * carries all five.
 */
export interface ProcessorMetricLabels {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id?: string | undefined;
  readonly environment?: string | undefined;
  /**
   * Logical RabbitMQ topic family this metric scopes to (e.g.
   * `raw.events`, `enriched.events`). See `CANONICAL_STREAM_FAMILIES` in
   * `@polaris/shared-transport`.
   */
  readonly topic_family?: string | undefined;
  /**
   * Partition index, for metrics that are meaningfully per-partition — lag
   * above all, since one stalled partition is the failure mode the alerts
   * exist for.
   *
   * It was absent, so every partition wrote to the same gauge series and the
   * last writer won. The `polaris-processors` dashboard has meanwhile queried
   * `max by (processor_name, partition) (polaris_processor_lag_ms_last)`
   * against a label that could not exist.
   */
  readonly partition?: number | undefined;
  /**
   * Concrete RabbitMQ topic name resolved at emission time (the shared
   * family topic when the project is not isolated, or the dedicated
   * topic when it is). Required alongside `topic_family` so isolation
   * dashboards can compare shared vs dedicated share.
   */
  readonly concrete_topic?: string | undefined;
  /**
   * RabbitMQ partition the metric is scoped to. Required for the
   * per-partition skew dashboard from
   * `docs/architecture/03-rabbitmq-streams.md` "Per-Project
   * Observability".
   */
  readonly partition?: number | string | undefined;
}

/** Labels used by the failure counter. Extends the base with a reason code. */
export interface ProcessorFailureLabels extends ProcessorMetricLabels {
  readonly reason?: string | undefined;
}

/**
 * Sample shape emitted by `getSamples()`. Mirrors the Prometheus text-format
 * exposition shape so the migration is straightforward.
 */
export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string | number>>;
  readonly value: number;
}

/**
 * Per-label-tuple histogram state for one base metric name. Tracks
 * cumulative bucket counts plus the running `sum` and `count` that
 * Prometheus histograms expose.
 */
interface HistogramSeries {
  readonly bucketCounts: number[];
  sum: number;
  count: number;
}

/**
 * In-memory processor metrics registry.
 *
 * Counters increment on a per-label-tuple basis. Gauges replace the
 * previous value (last-seen semantics). Histograms accumulate cumulative
 * bucket counts plus a running sum and count, exposed through
 * `getSamples()` as `<name>_bucket{le="..."}`, `<name>_sum`, `<name>_count`
 * series so `histogram_quantile()` works in Grafana.
 *
 * The `_ms_last` gauges are kept alongside the histograms during the
 * CSH8YAL6 transition so existing dashboard panels don't go dark.
 */
export class ProcessorMetrics {
  private readonly counters = new Map<string, MetricSample>();
  private readonly gauges = new Map<string, MetricSample>();
  /**
   * Per-base-name histogram registry. Outer map keys are the base metric
   * name (e.g. `polaris_processor_lag_seconds`); inner map keys are the
   * encoded label tuple. Bucket boundaries are recorded once per base
   * name so `getSamples()` can emit `_bucket{le="..."}` series without
   * re-deriving them.
   */
  private readonly histograms = new Map<
    string,
    {
      readonly buckets: readonly number[];
      readonly series: Map<
        string,
        { readonly labels: Record<string, string | number>; state: HistogramSeries }
      >;
    }
  >();

  incrementConsumed(labels: ProcessorMetricLabels): void {
    this.incrementByLabels(METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL, toLabelRecord(labels));
  }

  incrementEmitted(labels: ProcessorMetricLabels): void {
    this.incrementByLabels(METRIC_PROCESSOR_EVENTS_EMITTED_TOTAL, toLabelRecord(labels));
  }

  incrementFailed(labels: ProcessorFailureLabels): void {
    this.incrementByLabels(METRIC_PROCESSOR_EVENTS_FAILED_TOTAL, toLabelRecord(labels));
  }

  incrementDlq(labels: ProcessorFailureLabels): void {
    this.incrementByLabels(METRIC_PROCESSOR_EVENTS_DLQ_TOTAL, toLabelRecord(labels));
  }

  incrementRetry(labels: ProcessorFailureLabels): void {
    this.incrementByLabels(METRIC_PROCESSOR_EVENTS_RETRY_TOTAL, toLabelRecord(labels));
  }

  /** A message acknowledged without being acted on. See the metric's doc. */
  incrementSkipped(labels: ProcessorFailureLabels): void {
    this.incrementByLabels(METRIC_PROCESSOR_EVENTS_SKIPPED_TOTAL, toLabelRecord(labels));
  }

  /**
   * Record the difference between `occurred_at`/`ingested_at` and the
   * moment the processor finished handling the message. Writes both the
   * legacy `_ms_last` gauge AND the `_seconds` histogram so dashboards in
   * transition do not go dark.
   */
  observeLagMs(labels: ProcessorMetricLabels, value: number): void {
    const labelRecord = toLabelRecord(labels);
    this.recordGauge(METRIC_PROCESSOR_LAG_MS_LAST, labelRecord, value);
    this.observeHistogram(
      METRIC_PROCESSOR_LAG_SECONDS,
      PROCESSOR_LAG_BUCKETS_SECONDS,
      labelRecord,
      value / 1000,
    );
  }

  /**
   * Record the wall-clock duration of a per-message handler invocation.
   * Writes both the legacy gauge and the `_seconds` histogram sibling.
   */
  observeHandlerDurationMs(labels: ProcessorMetricLabels, value: number): void {
    const labelRecord = toLabelRecord(labels);
    this.recordGauge(METRIC_PROCESSOR_HANDLER_DURATION_MS_LAST, labelRecord, value);
    this.observeHistogram(
      METRIC_PROCESSOR_HANDLER_DURATION_SECONDS,
      PROCESSOR_HANDLER_DURATION_BUCKETS_SECONDS,
      labelRecord,
      value / 1000,
    );
  }

  /** Snapshot of every counter + gauge + histogram series. Useful for tests. */
  getSamples(): MetricSample[] {
    const out: MetricSample[] = [];
    for (const sample of this.counters.values()) {
      out.push({ name: sample.name, labels: { ...sample.labels }, value: sample.value });
    }
    for (const sample of this.gauges.values()) {
      out.push({ name: sample.name, labels: { ...sample.labels }, value: sample.value });
    }
    for (const [name, registry] of this.histograms) {
      for (const series of registry.series.values()) {
        for (let i = 0; i < registry.buckets.length; i++) {
          const bound = registry.buckets[i];
          const count = series.state.bucketCounts[i];
          if (bound === undefined || count === undefined) continue;
          out.push({
            name: `${name}_bucket`,
            labels: { ...series.labels, le: formatBucketBound(bound) },
            value: count,
          });
        }
        out.push({
          name: `${name}_bucket`,
          labels: { ...series.labels, le: "+Inf" },
          value: series.state.count,
        });
        out.push({ name: `${name}_sum`, labels: { ...series.labels }, value: series.state.sum });
        out.push({
          name: `${name}_count`,
          labels: { ...series.labels },
          value: series.state.count,
        });
      }
    }
    return out;
  }

  /** Fetch a single counter by name + labels. Returns 0 when unobserved. */
  getCounter(name: string, labels: Readonly<Record<string, string | number>>): number {
    const key = sampleKey(name, labels);
    return this.counters.get(key)?.value ?? 0;
  }

  /** Fetch a single gauge by name + labels. Returns `undefined` when unobserved. */
  getGauge(name: string, labels: Readonly<Record<string, string | number>>): number | undefined {
    const key = sampleKey(name, labels);
    return this.gauges.get(key)?.value;
  }

  /**
   * Fetch the cumulative bucket count for a histogram base name + label
   * tuple at the given `le` boundary. Returns 0 when unobserved.
   * `Number.POSITIVE_INFINITY` returns the total count.
   */
  getHistogramBucket(
    name: string,
    labels: Readonly<Record<string, string | number>>,
    le: number,
  ): number {
    const registry = this.histograms.get(name);
    if (registry === undefined) return 0;
    const series = registry.series.get(sampleKey(name, labels));
    if (series === undefined) return 0;
    if (!Number.isFinite(le)) return series.state.count;
    const idx = registry.buckets.indexOf(le);
    if (idx === -1) return 0;
    return series.state.bucketCounts[idx] ?? 0;
  }

  /** Fetch the running histogram sum (in seconds). Returns 0 when unobserved. */
  getHistogramSum(name: string, labels: Readonly<Record<string, string | number>>): number {
    const registry = this.histograms.get(name);
    if (registry === undefined) return 0;
    return registry.series.get(sampleKey(name, labels))?.state.sum ?? 0;
  }

  /** Fetch the histogram observation count. Returns 0 when unobserved. */
  getHistogramCount(name: string, labels: Readonly<Record<string, string | number>>): number {
    const registry = this.histograms.get(name);
    if (registry === undefined) return 0;
    return registry.series.get(sampleKey(name, labels))?.state.count ?? 0;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  private incrementByLabels(name: string, labels: Readonly<Record<string, string | number>>): void {
    const key = sampleKey(name, labels);
    const existing = this.counters.get(key);
    if (existing === undefined) {
      this.counters.set(key, { name, labels: { ...labels }, value: 1 });
    } else {
      this.counters.set(key, { name, labels: existing.labels, value: existing.value + 1 });
    }
  }

  private recordGauge(
    name: string,
    labels: Readonly<Record<string, string | number>>,
    value: number,
  ): void {
    const key = sampleKey(name, labels);
    const existing = this.gauges.get(key);
    if (existing === undefined) {
      this.gauges.set(key, { name, labels: { ...labels }, value });
    } else {
      this.gauges.set(key, { name, labels: existing.labels, value });
    }
  }

  private observeHistogram(
    name: string,
    buckets: readonly number[],
    labels: Readonly<Record<string, string | number>>,
    value: number,
  ): void {
    let registry = this.histograms.get(name);
    if (registry === undefined) {
      registry = { buckets, series: new Map() };
      this.histograms.set(name, registry);
    }
    const key = sampleKey(name, labels);
    let entry = registry.series.get(key);
    if (entry === undefined) {
      entry = {
        labels: { ...labels },
        state: {
          bucketCounts: new Array(registry.buckets.length).fill(0),
          sum: 0,
          count: 0,
        },
      };
      registry.series.set(key, entry);
    }
    entry.state.sum += value;
    entry.state.count += 1;
    for (let i = 0; i < registry.buckets.length; i++) {
      const bound = registry.buckets[i];
      if (bound === undefined) continue;
      if (value <= bound) {
        const current = entry.state.bucketCounts[i];
        entry.state.bucketCounts[i] = (current ?? 0) + 1;
      }
    }
  }
}

function formatBucketBound(bound: number): string {
  if (Number.isInteger(bound)) return bound.toString(10);
  return bound.toString();
}

function sampleKey(name: string, labels: Readonly<Record<string, string | number>>): string {
  const keys = Object.keys(labels).sort();
  const parts = keys.map((k) => `${k}=${labels[k]}`);
  return `${name}|${parts.join(",")}`;
}

function toLabelRecord(labels: object): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) continue;
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}
