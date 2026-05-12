import {
  POLARIS_INGEST_REDACTED_PATTERN_TOTAL,
  type PatternRedactionMetricIncrement,
} from "@polaris/shared-policy";

/**
 * In-process counter registry used by the ingester.
 *
 * The platform direction (per `08-observability-and-operations.md`) is
 * Prometheus + OpenTelemetry through a shared metrics package that does
 * not yet exist in v1. Until that package lands, the ingester keeps a
 * tiny in-memory registry so:
 *
 *   - the redaction metric helper from `@polaris/shared-policy` has a
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
 */

/** Stable metric names emitted by the ingester. */
export const METRIC_INGEST_REDACTED_PATTERN_TOTAL = POLARIS_INGEST_REDACTED_PATTERN_TOTAL;
export const METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL =
  "polaris_ingest_deprecated_schema_version_total";
export const METRIC_INGEST_BATCH_ACCEPTED_TOTAL = "polaris_ingest_batch_accepted_total";
export const METRIC_INGEST_BATCH_REJECTED_TOTAL = "polaris_ingest_batch_rejected_total";
export const METRIC_INGEST_DEDUPE_HIT_TOTAL = "polaris_ingest_dedupe_hit_total";
export const METRIC_INGEST_DEDUPE_SKIPPED_TOTAL = "polaris_ingest_dedupe_skipped_total";

export interface DeprecatedSchemaVersionLabels {
  readonly event: string;
  readonly schema_version: number;
}

export interface BatchOutcomeLabels {
  readonly project_id: string;
  readonly environment: string;
  readonly reason?: string;
}

export interface DedupeOutcomeLabels {
  readonly project_id: string;
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
