/**
 * In-process destination consumer metrics.
 *
 * Mirrors the `ProcessorMetrics` pattern in `@polaris/pipeline`:
 * a tiny in-memory counter/gauge/histogram registry that:
 *
 *   - gives the destination runtime a deterministic sink for unit tests,
 *   - keeps the call sites in shape for the future Prometheus migration
 *     (P10-002 swaps the implementation, not the API surface).
 *
 * The registry never stores raw event values. It stores label tuples
 * (vendor, consumer_version, destination_id, project_id, environment,
 * status / error_class) and per-tuple counters / gauges / histograms.
 *
 * Label cardinality is bounded by the active destination instance count ×
 * status / error_class set. Even the largest workspace stays well under
 * Prometheus' soft limit, and the migration will pivot on the same labels.
 *
 * **Latency histograms (CSH8YAL6).** Each `_ms_last` gauge has a histogram
 * sibling under the `*_seconds` name (Prometheus convention: observe in
 * seconds). Buckets cover the achievable per-vendor delivery latency
 * range (10ms–30s) and the rate-limit lease wait range (1ms–30s). The
 * `_ms_last` gauges are intentionally kept in place so existing
 * dashboards do not go dark during the transition. Histogram samples are
 * emitted through `getSamples()` as `<name>_bucket{le="..."}`,
 * `<name>_sum`, `<name>_count`; `histogram_quantile()` in Grafana works
 * on the bucket series directly.
 *
 * @see libs/pipeline/src/metrics.ts (ProcessorMetrics)
 * @see docs/architecture/08-observability-and-operations.md
 * @see docs/operations/slos.md
 */

/** Stable metric names emitted by destination runtimes. */
export const METRIC_DESTINATION_EVENTS_CONSUMED_TOTAL = "polaris_destination_events_consumed_total";
export const METRIC_DESTINATION_EVENTS_DELIVERED_TOTAL =
  "polaris_destination_events_delivered_total";
export const METRIC_DESTINATION_EVENTS_DROPPED_TOTAL = "polaris_destination_events_dropped_total";
export const METRIC_DESTINATION_EVENTS_FAILED_TOTAL = "polaris_destination_events_failed_total";
export const METRIC_DESTINATION_EVENTS_DLQ_TOTAL = "polaris_destination_events_dlq_total";
export const METRIC_DESTINATION_EVENTS_RETRY_TOTAL = "polaris_destination_events_retry_total";
export const METRIC_DESTINATION_EVENTS_SKIPPED_TOTAL = "polaris_destination_events_skipped_total";
export const METRIC_DESTINATION_EVENTS_DEDUPED_TOTAL = "polaris_destination_events_deduped_total";
/**
 * Circuit-breaker state per destination instance: 0 closed, 1 half-open,
 * 2 open.
 *
 * A gauge rather than a counter, because the question an operator asks is
 * "is this destination cut off right now?" — and a counter of trips answers
 * a different one. The numeric encoding is what lets a single panel show
 * every instance's state at a glance and an alert fire on `== 2`.
 */
export const METRIC_DESTINATION_BREAKER_STATE = "polaris_destination_breaker_state";
export const METRIC_DESTINATION_REPLAY_SUPPRESSED_TOTAL =
  "polaris_destination_replay_suppressed_total";
export const METRIC_DESTINATION_DELIVERY_DURATION_MS_LAST =
  "polaris_destination_delivery_duration_ms_last";
export const METRIC_DESTINATION_RATE_LIMIT_WAIT_MS_LAST =
  "polaris_destination_rate_limit_wait_ms_last";

/**
 * Histogram base name for destination delivery duration (sibling to
 * `polaris_destination_delivery_duration_ms_last`). Observations are in
 * **seconds**. Emits three series families:
 *
 *   - `polaris_destination_delivery_duration_seconds_bucket{le="..."}`
 *   - `polaris_destination_delivery_duration_seconds_sum`
 *   - `polaris_destination_delivery_duration_seconds_count`
 */
export const METRIC_DESTINATION_DELIVERY_DURATION_SECONDS =
  "polaris_destination_delivery_duration_seconds";

/**
 * Histogram base name for rate-limit lease wait. Same three-family
 * emission as the delivery duration histogram.
 */
export const METRIC_DESTINATION_RATE_LIMIT_WAIT_SECONDS =
  "polaris_destination_rate_limit_wait_seconds";

/**
 * Bucket boundaries (seconds, upper-inclusive) for the delivery duration
 * histogram. Vendor APIs typically respond between 100ms and a few
 * seconds; the buckets span 10ms (hot-cache hit) to 30s (slow vendor /
 * retried request) so the per-vendor p99 panel surfaces both regimes.
 * The exact achievable p99 is vendor-specific — see each consumer's
 * README per `docs/operations/slos.md`.
 */
export const DESTINATION_DELIVERY_DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30,
]);

/**
 * Bucket boundaries (seconds, upper-inclusive) for the rate-limit lease
 * wait histogram. Most waits are below 100ms (token-bucket happy path);
 * the upper end of the range accommodates back-pressured leases.
 */
/**
 * End-to-end freshness: `occurred_at` to the moment the vendor accepted.
 *
 * The number a destination's SLO is actually about. Delivery DURATION only
 * covers the HTTP call, so a destination whose vendor answers in 40ms while
 * its consumer sits an hour behind looks perfectly healthy on every existing
 * panel — the lag is upstream of the only thing being measured.
 *
 * Measured from `occurred_at`, the producer's clock, not `ingested_at`. That
 * makes it sensitive to producer clock skew, and it is still the right
 * choice: the question is "how stale is what the vendor knows about this
 * customer", and the customer did the thing at `occurred_at`.
 */
export const METRIC_DESTINATION_FRESHNESS_SECONDS = "polaris_destination_freshness_seconds";

/**
 * Buckets from a second to six hours.
 *
 * Wide, because the two failure modes have very different scales: a
 * rate-limited destination runs seconds behind, while one whose consumer has
 * been down since the morning runs hours behind, and a p99 that saturates at
 * the top bucket cannot tell an operator which they have.
 */
export const DESTINATION_FRESHNESS_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  1, 5, 15, 60, 300, 900, 3600, 10_800, 21_600,
]);

export const DESTINATION_RATE_LIMIT_WAIT_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30,
]);

/**
 * Label tuple every destination metric carries. `vendor` + `consumer_version`
 * is the immutable identity; `(destination_id, project_id, environment)`
 * scopes the metric to the instance.
 *
 * **Topic-family labels (P11-008).** Every destination consumer reads
 * from `analytics.events` (or its dedicated variant when a project is
 * isolated). Per `docs/architecture/03-rabbitmq-streams.md`
 * "Per-Project Observability", emissions MUST carry the topic-family
 * triple (`topic_family`, `concrete_topic`, `partition`) so the
 * per-project share / lag / skew dashboards work without a code
 * change. The fields are optional on the type because some metrics
 * (rate-limit wait, replay suppression) are not partition-scoped; the
 * architecture rule applies to per-RabbitMQ-message emissions.
 */
export interface DestinationMetricLabels {
  readonly vendor: string;
  readonly consumer_version: string;
  readonly destination_id?: string | undefined;
  readonly project_id?: string | undefined;
  readonly environment?: string | undefined;
  /**
   * Logical RabbitMQ topic family this metric scopes to. See
   * `CANONICAL_STREAM_FAMILIES` in `@polaris/bus`. Required on
   * per-message emissions; optional on aggregate metrics (rate-limit
   * wait, replay suppression) that are not partition-scoped.
   */
  readonly topic_family?: string | undefined;
  /**
   * Concrete RabbitMQ topic name resolved at consume time (the shared
   * family topic, or the dedicated topic when the project is
   * isolated). Required alongside `topic_family` so isolation
   * dashboards can compare shared vs dedicated share.
   */
  readonly concrete_topic?: string | undefined;
  /**
   * RabbitMQ partition the metric is scoped to. Required for the
   * per-partition skew dashboard.
   */
  readonly partition?: number | string | undefined;
}

/** Labels used by failure / drop counters. Extends the base with a reason. */
export interface DestinationOutcomeLabels extends DestinationMetricLabels {
  readonly reason?: string | undefined;
}

/** Sample shape emitted by `getSamples()`. */
export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string | number>>;
  readonly value: number;
}

interface HistogramSeries {
  readonly bucketCounts: number[];
  sum: number;
  count: number;
}

/**
 * In-memory destination metrics registry.
 *
 * Counters increment on a per-label-tuple basis. Gauges replace the
 * previous value (last-seen semantics). Histograms accumulate cumulative
 * bucket counts plus a running sum and count, exposed through
 * `getSamples()` as `<name>_bucket{le="..."}`, `<name>_sum`, `<name>_count`
 * series so `histogram_quantile()` works in Grafana. The `_ms_last` gauges
 * are kept alongside the histograms during the CSH8YAL6 transition so
 * existing dashboard panels do not go dark.
 */
export class DestinationMetrics {
  private readonly counters = new Map<string, MetricSample>();
  private readonly gauges = new Map<string, MetricSample>();
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

  incrementConsumed(labels: DestinationMetricLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_EVENTS_CONSUMED_TOTAL, toLabelRecord(labels));
  }

  incrementDelivered(labels: DestinationMetricLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_EVENTS_DELIVERED_TOTAL, toLabelRecord(labels));
  }

  incrementDropped(labels: DestinationOutcomeLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_EVENTS_DROPPED_TOTAL, toLabelRecord(labels));
  }

  incrementFailed(labels: DestinationOutcomeLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_EVENTS_FAILED_TOTAL, toLabelRecord(labels));
  }

  incrementDlq(labels: DestinationOutcomeLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_EVENTS_DLQ_TOTAL, toLabelRecord(labels));
  }

  incrementRetry(labels: DestinationOutcomeLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_EVENTS_RETRY_TOTAL, toLabelRecord(labels));
  }

  incrementSkipped(labels: DestinationOutcomeLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_EVENTS_SKIPPED_TOTAL, toLabelRecord(labels));
  }

  incrementDeduped(labels: DestinationMetricLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_EVENTS_DEDUPED_TOTAL, toLabelRecord(labels));
  }

  incrementReplaySuppressed(labels: DestinationMetricLabels): void {
    this.incrementByLabels(METRIC_DESTINATION_REPLAY_SUPPRESSED_TOTAL, toLabelRecord(labels));
  }

  /**
   * Record the wall-clock duration of one delivery attempt. Writes both
   * the legacy `_ms_last` gauge AND the `_seconds` histogram sibling so
   * dashboards in transition do not go dark.
   */
  observeDeliveryDurationMs(labels: DestinationMetricLabels, value: number): void {
    const labelRecord = toLabelRecord(labels);
    this.recordGauge(METRIC_DESTINATION_DELIVERY_DURATION_MS_LAST, labelRecord, value);
    this.observeHistogram(
      METRIC_DESTINATION_DELIVERY_DURATION_SECONDS,
      DESTINATION_DELIVERY_DURATION_BUCKETS_SECONDS,
      labelRecord,
      value / 1000,
    );
  }

  /**
   * Record how stale an event was when the vendor accepted it.
   *
   * Only on acceptance. A failed delivery has no freshness — the vendor does
   * not know about the event at all — and folding failures in would make the
   * SLO improve every time a destination started dropping traffic.
   */
  observeFreshnessMs(labels: DestinationMetricLabels, value: number): void {
    // A negative value means the producer's clock is ahead of ours. Clamped
    // rather than dropped: the delivery happened, and a missing observation
    // would quietly bias the percentile toward the slow tail.
    this.observeHistogram(
      METRIC_DESTINATION_FRESHNESS_SECONDS,
      DESTINATION_FRESHNESS_BUCKETS_SECONDS,
      toLabelRecord(labels),
      Math.max(0, value) / 1000,
    );
  }

  /**
   * Publish a breaker's current state.
   *
   * Called on every transition rather than on a timer, so the series moves
   * the moment the breaker does. A gauge left un-updated would report a
   * destination as cut off long after it recovered.
   */
  setBreakerState(labels: DestinationMetricLabels, state: "closed" | "half_open" | "open"): void {
    const numeric = state === "open" ? 2 : state === "half_open" ? 1 : 0;
    this.recordGauge(METRIC_DESTINATION_BREAKER_STATE, toLabelRecord(labels), numeric);
  }

  /**
   * Record the time a delivery spent waiting on the rate-limit lease.
   * Writes both the legacy gauge and the `_seconds` histogram sibling.
   */
  observeRateLimitWaitMs(labels: DestinationMetricLabels, value: number): void {
    const labelRecord = toLabelRecord(labels);
    this.recordGauge(METRIC_DESTINATION_RATE_LIMIT_WAIT_MS_LAST, labelRecord, value);
    this.observeHistogram(
      METRIC_DESTINATION_RATE_LIMIT_WAIT_SECONDS,
      DESTINATION_RATE_LIMIT_WAIT_BUCKETS_SECONDS,
      labelRecord,
      value / 1000,
    );
  }

  /** Snapshot every counter + gauge + histogram series. */
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

  /** Fetch one counter by name + labels. Returns 0 when unobserved. */
  getCounter(name: string, labels: Readonly<Record<string, string | number>>): number {
    return this.counters.get(sampleKey(name, labels))?.value ?? 0;
  }

  /** Fetch one gauge by name + labels. Returns `undefined` when unobserved. */
  getGauge(name: string, labels: Readonly<Record<string, string | number>>): number | undefined {
    return this.gauges.get(sampleKey(name, labels))?.value;
  }

  /**
   * Fetch the cumulative histogram bucket count for a base name + label
   * tuple at the given `le` boundary. `Number.POSITIVE_INFINITY` returns
   * the total count.
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
