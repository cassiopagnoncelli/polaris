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
 * `failed`, `dlq`). The lag observation is a simple max/last bucket — the
 * v1 implementation does NOT track full histograms; that arrives with the
 * Prometheus migration.
 *
 * @see apps/ingester-api/src/metrics/registry.ts (IngestMetrics)
 * @see docs/architecture/08-observability-and-operations.md
 */

/** Stable metric names emitted by processor runtimes. */
export const METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL = "polaris_processor_events_consumed_total";
export const METRIC_PROCESSOR_EVENTS_EMITTED_TOTAL = "polaris_processor_events_emitted_total";
export const METRIC_PROCESSOR_EVENTS_FAILED_TOTAL = "polaris_processor_events_failed_total";
export const METRIC_PROCESSOR_EVENTS_DLQ_TOTAL = "polaris_processor_events_dlq_total";
export const METRIC_PROCESSOR_EVENTS_RETRY_TOTAL = "polaris_processor_events_retry_total";
export const METRIC_PROCESSOR_LAG_MS_LAST = "polaris_processor_lag_ms_last";
export const METRIC_PROCESSOR_HANDLER_DURATION_MS_LAST =
  "polaris_processor_handler_duration_ms_last";

/**
 * Label tuple every processor metric carries. The processor `(name,
 * version)` is the immutable identity; `(project_id, environment)` is the
 * per-event scope and is optional because some processors (sessionizer,
 * geoip-enricher) operate cross-project.
 */
export interface ProcessorMetricLabels {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id?: string | undefined;
  readonly environment?: string | undefined;
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
 * In-memory processor metrics registry.
 *
 * Counters increment on a per-label-tuple basis. Lag observations replace
 * the previous value (last-seen semantics) — the v1 implementation does
 * not maintain a full histogram. The future Prometheus binding (P10-002)
 * swaps this class out for a real histogram backend.
 */
export class ProcessorMetrics {
  private readonly counters = new Map<string, MetricSample>();
  private readonly gauges = new Map<string, MetricSample>();

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

  /**
   * Record the difference between `occurred_at`/`ingested_at` and the
   * moment the processor finished handling the message. The v1
   * implementation stores the last observation; the future Prometheus
   * migration will switch to a histogram with buckets matching the
   * observability runbook.
   */
  observeLagMs(labels: ProcessorMetricLabels, value: number): void {
    this.recordGauge(METRIC_PROCESSOR_LAG_MS_LAST, toLabelRecord(labels), value);
  }

  /**
   * Record the wall-clock duration of a per-message handler invocation.
   */
  observeHandlerDurationMs(labels: ProcessorMetricLabels, value: number): void {
    this.recordGauge(METRIC_PROCESSOR_HANDLER_DURATION_MS_LAST, toLabelRecord(labels), value);
  }

  /** Snapshot of every counter + gauge seen. Useful for tests. */
  getSamples(): MetricSample[] {
    return [...this.counters.values(), ...this.gauges.values()].map((sample) => ({
      name: sample.name,
      labels: { ...sample.labels },
      value: sample.value,
    }));
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

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
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
