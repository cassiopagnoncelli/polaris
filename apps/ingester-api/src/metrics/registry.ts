import {
  type PatternRedactionMetricIncrement,
  POLARIS_INGEST_REDACTED_PATTERN_TOTAL,
} from "@polaris/governance";

/**
 * In-process counter registry used by the ingester.
 *
 * The platform direction (per `08-observability-and-operations.md`) is
 * Prometheus + OpenTelemetry through a shared metrics package that does
 * not yet exist in v1. Until that package lands, the ingester keeps a
 * tiny in-memory registry so:
 *
 *   - the redaction metric helper from `@polaris/governance` has a
 *     concrete sink to increment,
 *   - tests can assert metric emission deterministically,
 *   - the future migration to Prometheus is a swap of the `incrementCounter`
 *     implementation, not a rewrite of the call sites.
 *
 * The registry never stores raw event values. It stores label tuples
 * (project_id, environment, reason, pattern, ...) and per-tuple counters.
 *
 * Label cardinality is bounded:
 *   - `polaris_ingest_redacted_pattern_total`: project × env × {pii_card,pii_secret} × pattern (~5)
 *   - `polaris_ingest_deprecated_schema_version_total`: event × schema_version (small)
 *
 * Both stay well under any reasonable Prometheus alert threshold.
 *
 * **Accept latency histogram (CSH8YAL6).** The ingester did not previously
 * emit an accept-latency gauge — the `_ms_last` siblings the task card
 * references only existed in the processor and destination registries.
 * Per the card's acceptance criterion (`ingester accept latency p99
 * panel`), a `polaris_ingest_accept_duration_seconds` histogram is added
 * here with buckets sized against the v1 SLO surface in
 * `docs/operations/slos.md` (200ms p99, 500ms p999). Observations are in
 * seconds per Prometheus convention. `getSamples()` emits the canonical
 * three series families (`_bucket{le="..."}`, `_sum`, `_count`);
 * `histogram_quantile()` in Grafana works on the bucket series directly.
 */

/** Stable metric names emitted by the ingester. */
export const METRIC_INGEST_REDACTED_PATTERN_TOTAL = POLARIS_INGEST_REDACTED_PATTERN_TOTAL;
export const METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL =
  "polaris_ingest_deprecated_schema_version_total";
export const METRIC_INGEST_BATCH_ACCEPTED_TOTAL = "polaris_ingest_batch_accepted_total";
export const METRIC_INGEST_BATCH_REJECTED_TOTAL = "polaris_ingest_batch_rejected_total";
export const METRIC_INGEST_DEDUPE_HIT_TOTAL = "polaris_ingest_dedupe_hit_total";
export const METRIC_INGEST_DEDUPE_SKIPPED_TOTAL = "polaris_ingest_dedupe_skipped_total";
export const METRIC_INGEST_ORIGIN_REJECTED_TOTAL = "polaris_ingest_origin_rejected_total";
export const METRIC_INGEST_RATE_LIMIT_REJECTED_TOTAL = "polaris_ingest_rate_limit_rejected_total";
export const METRIC_INGEST_RATE_LIMIT_SKIPPED_TOTAL = "polaris_ingest_rate_limit_skipped_total";
export const METRIC_INGEST_PUBLISH_FAILED_TOTAL = "polaris_ingest_publish_failed_total";
/**
 * Violations published to the quarantine, by reason.
 *
 * Cardinality is project × env × reason, where reason is the closed batch
 * reason set (~10) — the same shape as the rejection counter it shadows.
 * It exists SEPARATELY from `polaris_ingest_batch_rejected_total` because
 * the two answer different questions: that one is "was the event
 * refused?", this one is "did the refusal reach the governance loop?".
 * A gap between them is a broken quarantine, and with a fail-open
 * publisher that gap is the ONLY thing that would report it.
 */
export const METRIC_INGEST_VIOLATION_PUBLISHED_TOTAL = "polaris_ingest_violation_published_total";
export const METRIC_INGEST_VIOLATION_DROPPED_TOTAL = "polaris_ingest_violation_dropped_total";
/**
 * A project whose stored `ingest` config slice failed to parse, so the batch
 * fell back to deployment defaults. Non-zero means an operator wrote a value
 * this build cannot read — alertable, because that fallback is deliberately
 * silent to producers (plan §5: never reject ingest).
 */
export const METRIC_INGEST_PROJECT_CONFIG_INVALID_TOTAL =
  "polaris_ingest_project_config_invalid_total";
export const METRIC_INGEST_PUBLISH_SUCCESS_TOTAL = "polaris_ingest_publish_success_total";

/**
 * Histogram base name for ingester accept latency (per-request wall-clock
 * duration of `POST /v1/events`). Observations are in **seconds**. The
 * registry emits three series families:
 *
 *   - `polaris_ingest_accept_duration_seconds_bucket{le="..."}`
 *   - `polaris_ingest_accept_duration_seconds_sum`
 *   - `polaris_ingest_accept_duration_seconds_count`
 */
export const METRIC_INGEST_ACCEPT_DURATION_SECONDS = "polaris_ingest_accept_duration_seconds";

/**
 * Bucket boundaries (seconds, upper-inclusive) for the accept latency
 * histogram. Sized against the v1 SLO surface in
 * `docs/operations/slos.md`: p99 ≤ 200ms, p999 ≤ 500ms. The buckets span
 * well below and well above the SLO so the panel surfaces both healthy
 * and saturated regimes — `0.005`–`0.1` cover sub-SLO ingest, `0.2`/`0.5`
 * straddle the SLO thresholds, and `1`–`5` cover the saturated tail.
 */
export const INGEST_ACCEPT_DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5,
]);

export interface DeprecatedSchemaVersionLabels {
  readonly event: string;
  readonly schema_version: number;
}

export interface BatchOutcomeLabels {
  readonly project_id: string;
  readonly environment: string;
  readonly reason?: string;
  /**
   * The event NAME, or `UNREGISTERED_EVENT_LABEL` when the producer sent
   * one the catalog does not register.
   *
   * Required, not optional. R12 promises per-event-type volume-anomaly
   * alerts, and this counter is what they read: without the dimension the
   * alert groups by, `PolarisIngestRejectionSpike` could only say "this
   * project's rejections spiked" — the same answer for a bad SDK release
   * and for one broken event type. The label types declare `environment`
   * optional and that is exactly how an emitter shipped without scope
   * once; a required field is the only version of this a compiler
   * enforces at every call site.
   *
   * Cardinality is bounded by the catalog because callers pass
   * {@link eventLabel}, never a raw producer string.
   */
  readonly event: string;
}

/**
 * Stand-in for an event name the catalog does not register.
 *
 * Angle brackets so it cannot collide with a real name — the catalog's own
 * format rules forbid them.
 */
export const UNREGISTERED_EVENT_LABEL = "<unregistered>" as const;

/**
 * The `event` label for the ingest counters, bounded by the catalog.
 *
 * An event name arriving on a rejected event is producer-supplied and has
 * not been validated yet — passing it to a counter unfiltered lets anyone
 * holding an API key mint unlimited Prometheus series by sending events
 * named after a UUID. Everything the catalog does not register collapses
 * to one sentinel.
 *
 * WHICH unregistered name arrived is not lost: the quarantine record on
 * `rejected.events` carries it verbatim, and that is a store built for
 * unbounded strings. `polaris violations list` is where you look; a time
 * series is not.
 *
 * The catalog is taken structurally so both call sites — the ingest
 * handler and the quarantine's counter callback — pass the same
 * `EventCatalog` without this module importing it, and so a test can pass
 * a two-line stub.
 */
export function eventLabel(
  name: string | undefined,
  catalog: { hasEvent(event: string): boolean },
): string {
  if (name === undefined || name === "") return UNREGISTERED_EVENT_LABEL;
  return catalog.hasEvent(name) ? name : UNREGISTERED_EVENT_LABEL;
}

export interface DedupeOutcomeLabels {
  readonly project_id: string;
  readonly environment: string;
}

export interface OriginRejectedLabels {
  readonly project_id: string;
  readonly environment: string;
}

export interface RateLimitLabels {
  readonly project_id: string;
  readonly environment: string;
}

export interface PublishSuccessLabels {
  readonly project_id: string;
  readonly environment: string;
  readonly topic: string;
}

export interface PublishFailedLabels {
  readonly project_id: string;
  readonly environment: string;
  readonly topic: string;
  readonly reason: string;
}

/**
 * Label tuple carried by the accept-duration histogram. `environment` is
 * the only label so cardinality stays bounded across project growth —
 * adding `project_id` here would explode bucket cardinality (10 buckets ×
 * N projects × 3 environments). Per-project breakdowns are available
 * through the per-project topic-isolation dashboards from P11-008.
 */
export interface AcceptDurationLabels {
  readonly environment: string;
}

/**
 * Sample exposed by `getSamples()`. Mirrors the shape Prometheus expects so
 * a future text-format exposition can iterate the array directly.
 */
export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string | number>>;
  readonly value: number;
}

/**
 * Tiny in-memory counter registry. Keys are deterministic strings derived
 * from the label tuple so concurrent increments on the same tuple share a
 * counter.
 */
export class IngestMetrics {
  private readonly counters = new Map<string, MetricSample>();

  incrementPatternRedaction(increment: PatternRedactionMetricIncrement): void {
    this.incrementByLabels(METRIC_INGEST_REDACTED_PATTERN_TOTAL, toLabelRecord(increment.labels));
  }

  incrementDeprecatedSchemaVersion(labels: DeprecatedSchemaVersionLabels): void {
    this.incrementByLabels(METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL, toLabelRecord(labels));
  }

  incrementProjectConfigInvalid(labels: { project_id: string; environment: string }): void {
    this.incrementByLabels(METRIC_INGEST_PROJECT_CONFIG_INVALID_TOTAL, toLabelRecord(labels));
  }

  incrementAccepted(labels: BatchOutcomeLabels): void {
    this.incrementByLabels(METRIC_INGEST_BATCH_ACCEPTED_TOTAL, toLabelRecord(labels));
  }

  incrementRejected(labels: BatchOutcomeLabels): void {
    this.incrementByLabels(METRIC_INGEST_BATCH_REJECTED_TOTAL, toLabelRecord(labels));
  }

  incrementDedupeHit(labels: DedupeOutcomeLabels): void {
    this.incrementByLabels(METRIC_INGEST_DEDUPE_HIT_TOTAL, toLabelRecord(labels));
  }

  incrementDedupeSkipped(labels: DedupeOutcomeLabels): void {
    this.incrementByLabels(METRIC_INGEST_DEDUPE_SKIPPED_TOTAL, toLabelRecord(labels));
  }

  incrementOriginRejected(labels: OriginRejectedLabels): void {
    this.incrementByLabels(METRIC_INGEST_ORIGIN_REJECTED_TOTAL, toLabelRecord(labels));
  }

  incrementRateLimitRejected(labels: RateLimitLabels): void {
    this.incrementByLabels(METRIC_INGEST_RATE_LIMIT_REJECTED_TOTAL, toLabelRecord(labels));
  }

  incrementRateLimitSkipped(labels: RateLimitLabels): void {
    this.incrementByLabels(METRIC_INGEST_RATE_LIMIT_SKIPPED_TOTAL, toLabelRecord(labels));
  }

  incrementPublishSuccess(labels: PublishSuccessLabels): void {
    this.incrementByLabels(METRIC_INGEST_PUBLISH_SUCCESS_TOTAL, toLabelRecord(labels));
  }

  incrementViolationPublished(labels: BatchOutcomeLabels): void {
    this.incrementByLabels(METRIC_INGEST_VIOLATION_PUBLISHED_TOTAL, toLabelRecord(labels));
  }

  /**
   * A violation the quarantine could not publish. Fail-open by design, so
   * this counter is the only evidence the loop is broken.
   */
  incrementViolationDropped(labels: { reason: string }): void {
    this.incrementByLabels(METRIC_INGEST_VIOLATION_DROPPED_TOTAL, toLabelRecord(labels));
  }

  incrementPublishFailed(labels: PublishFailedLabels): void {
    this.incrementByLabels(METRIC_INGEST_PUBLISH_FAILED_TOTAL, toLabelRecord(labels));
  }

  /** Returns a snapshot of every counter the registry has seen. */
  getSamples(): MetricSample[] {
    return Array.from(this.counters.values()).map((sample) => ({
      name: sample.name,
      labels: { ...sample.labels },
      value: sample.value,
    }));
  }

  /**
   * Fetch a single counter value by name + labels. Returns 0 when the
   * label tuple has never been observed.
   */
  getCounter(name: string, labels: Readonly<Record<string, string | number>>): number {
    const key = sampleKey(name, labels);
    return this.counters.get(key)?.value ?? 0;
  }

  reset(): void {
    this.counters.clear();
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
}

function sampleKey(name: string, labels: Readonly<Record<string, string | number>>): string {
  const keys = Object.keys(labels).sort();
  const parts = keys.map((k) => `${k}=${labels[k]}`);
  return `${name}|${parts.join(",")}`;
}

/**
 * Convert a typed label record (e.g. `PatternRedactionMetricLabels`) into
 * the structurally-typed `Record<string, string | number>` the registry
 * uses internally. The typed shapes don't have an index signature so a
 * direct assignment fails under `noPropertyAccessFromIndexSignature`; this
 * helper does the safe spread once per increment.
 *
 * The input is typed as `object` to accept any concrete label shape; the
 * body only reads enumerable string/number properties so values that the
 * registry can't represent (booleans, nested objects) are silently dropped.
 */
function toLabelRecord(labels: object): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}
