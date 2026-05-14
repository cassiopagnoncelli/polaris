/**
 * In-process destination consumer metrics.
 *
 * Mirrors the `ProcessorMetrics` pattern in `@polaris/shared-processor`:
 * a tiny in-memory counter/gauge registry that:
 *
 *   - gives the destination runtime a deterministic sink for unit tests,
 *   - keeps the call sites in shape for the future Prometheus migration
 *     (P10-002 swaps the implementation, not the API surface).
 *
 * The registry never stores raw event values. It stores label tuples
 * (vendor, consumer_version, destination_id, project_id, environment,
 * status / error_class) and per-tuple counters / gauges.
 *
 * Label cardinality is bounded by the active destination instance count ×
 * status / error_class set. Even the largest workspace stays well under
 * Prometheus' soft limit, and the migration will pivot on the same labels.
 *
 * @see packages/shared-processor/src/metrics.ts (ProcessorMetrics)
 * @see docs/architecture/08-observability-and-operations.md
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
export const METRIC_DESTINATION_REPLAY_SUPPRESSED_TOTAL =
  "polaris_destination_replay_suppressed_total";
export const METRIC_DESTINATION_DELIVERY_DURATION_MS_LAST =
  "polaris_destination_delivery_duration_ms_last";
export const METRIC_DESTINATION_RATE_LIMIT_WAIT_MS_LAST =
  "polaris_destination_rate_limit_wait_ms_last";

/**
 * Label tuple every destination metric carries. `vendor` + `consumer_version`
 * is the immutable identity; `(destination_id, project_id, environment)`
 * scopes the metric to the instance.
 *
 * **Topic-family labels (P11-008).** Every destination consumer reads
 * from `analytics.events` (or its dedicated variant when a project is
 * isolated). Per `docs/architecture/03-redpanda-topics.md`
 * "Per-Project Observability", emissions MUST carry the topic-family
 * triple (`topic_family`, `concrete_topic`, `partition`) so the
 * per-project share / lag / skew dashboards work without a code
 * change. The fields are optional on the type because some metrics
 * (rate-limit wait, replay suppression) are not partition-scoped; the
 * architecture rule applies to per-Redpanda-message emissions.
 */
export interface DestinationMetricLabels {
  readonly vendor: string;
  readonly consumer_version: string;
  readonly destination_id?: string | undefined;
  readonly project_id?: string | undefined;
  readonly environment?: string | undefined;
  /**
   * Logical Redpanda topic family this metric scopes to. See
   * `CANONICAL_TOPIC_FAMILIES` in `@polaris/shared-kafka`. Required on
   * per-message emissions; optional on aggregate metrics (rate-limit
   * wait, replay suppression) that are not partition-scoped.
   */
  readonly topic_family?: string | undefined;
  /**
   * Concrete Redpanda topic name resolved at consume time (the shared
   * family topic, or the dedicated topic when the project is
   * isolated). Required alongside `topic_family` so isolation
   * dashboards can compare shared vs dedicated share.
   */
  readonly concrete_topic?: string | undefined;
  /**
   * Redpanda partition the metric is scoped to. Required for the
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

/**
 * In-memory destination metrics registry.
 *
 * Counters increment on a per-label-tuple basis. Gauges replace the
 * previous value (last-seen semantics) — the v1 implementation does not
 * maintain full histograms. The future Prometheus binding (P10-002) swaps
 * this class out for a real histogram backend.
 */
export class DestinationMetrics {
  private readonly counters = new Map<string, MetricSample>();
  private readonly gauges = new Map<string, MetricSample>();

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

  observeDeliveryDurationMs(labels: DestinationMetricLabels, value: number): void {
    this.recordGauge(METRIC_DESTINATION_DELIVERY_DURATION_MS_LAST, toLabelRecord(labels), value);
  }

  observeRateLimitWaitMs(labels: DestinationMetricLabels, value: number): void {
    this.recordGauge(METRIC_DESTINATION_RATE_LIMIT_WAIT_MS_LAST, toLabelRecord(labels), value);
  }

  /** Snapshot every counter + gauge. */
  getSamples(): MetricSample[] {
    return [...this.counters.values(), ...this.gauges.values()].map((sample) => ({
      name: sample.name,
      labels: { ...sample.labels },
      value: sample.value,
    }));
  }

  /** Fetch one counter by name + labels. Returns 0 when unobserved. */
  getCounter(name: string, labels: Readonly<Record<string, string | number>>): number {
    return this.counters.get(sampleKey(name, labels))?.value ?? 0;
  }

  /** Fetch one gauge by name + labels. Returns `undefined` when unobserved. */
  getGauge(name: string, labels: Readonly<Record<string, string | number>>): number | undefined {
    return this.gauges.get(sampleKey(name, labels))?.value;
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
