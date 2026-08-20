/**
 * Prometheus text-format serializer for Polaris's in-memory metric
 * registries.
 *
 * Polaris's three subsystem registries — `IngestMetrics`,
 * `ProcessorMetrics`, `DestinationMetrics` — all expose
 * `getSamples(): MetricSample[]` returning `{ name, labels, value }`
 * triples (defined locally in each package; the shape is identical so
 * one helper can serve all three).
 *
 * P10-001 (observability compose) already configured Prometheus to scrape
 * each service's `/metrics` endpoint. P10-002 (this module) makes those
 * endpoints return real Prometheus text instead of the empty stub
 * `bootstrapService` ships by default.
 *
 * Hand-rolled per the [Prometheus exposition spec][1] — Polaris stays
 * framework-light and avoids the `prom-client` runtime dependency. The
 * serializer is intentionally minimal (counter + gauge only); histograms
 * and summaries land later if the registries grow them.
 *
 * Hard rules baked in:
 *
 *   - **Counters vs gauges by name suffix.** Polaris's metric vocabulary
 *     ends every counter in `_total` and every gauge in `_last` (or
 *     `_ms_last` for duration gauges). This convention is the source of
 *     truth — the converter does not require an out-of-band type hint on
 *     each sample.
 *   - **Stable label ordering.** Labels are emitted in alphabetical order
 *     within each line so a textual diff of two `/metrics` snapshots
 *     surfaces real changes, not key-order noise.
 *   - **One HELP + TYPE per metric name, regardless of how many samples
 *     share that name.** Per the spec: HELP and TYPE come once at the top
 *     of each metric block; sample lines follow.
 *   - **Label-value escape rules per the spec:** `\` → `\\`, newline →
 *     `\n`, `"` → `\"`. No other escapes (UTF-8 passes through).
 *   - **No PII in labels.** This is the registries' responsibility (they
 *     only put bounded values into labels: project_id, environment,
 *     vendor, source_id, event name, reason code, status). The serializer
 *     does not enforce a deny-list — it trusts the upstream. The
 *     architecture's metric label discipline (08-observability-and-operations.md)
 *     is enforced at the call site.
 *
 * @see docs/architecture/08-observability-and-operations.md
 * @see docs/implementation/tasks/P10-002-metrics-standardization.md
 * @see https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format
 *
 * [1]: https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format
 */

import type { MetricSample } from "./types.js";

/**
 * Operator-readable HELP text for each Polaris metric name.
 *
 * Prometheus' web UI and federation labels surface these strings; keeping
 * them in one place lets operators read the names at a glance without
 * cross-referencing the source. Unknown names fall back to a generic
 * "Polaris metric" string — useful for forward compatibility, but every
 * metric the registries currently produce should be listed here.
 */
const HELP_TEXT: Readonly<Record<string, string>> = {
  // -- ingester (apps/ingester-api/src/metrics/registry.ts) -----------
  polaris_ingest_batch_accepted_total:
    "Count of events accepted by the ingester and published to raw.events.",
  polaris_ingest_batch_rejected_total:
    "Count of events rejected by the ingester (labelled by `reason`).",
  polaris_ingest_dedupe_hit_total:
    "Count of incoming events the short-window dedupe layer recognised and dropped.",
  polaris_ingest_dedupe_skipped_total:
    "Count of dedupe lookups skipped because Redis was unavailable (fail-open).",
  polaris_ingest_deprecated_schema_version_total:
    "Count of accepted events whose declared schema_version is marked deprecated but pre-sunset.",
  polaris_ingest_origin_rejected_total:
    "Count of POST /v1/events requests refused by the per-source CORS allow-list.",
  polaris_ingest_redacted_pattern_total:
    "Count of pattern-based redactions applied to inbound events. Labels never carry the redacted value.",

  // -- processors (libs/pipeline/src/metrics.ts) ---------
  polaris_processor_events_consumed_total: "Count of raw events consumed by a Polaris processor.",
  polaris_processor_events_emitted_total:
    "Count of events emitted to a downstream topic by a Polaris processor.",
  polaris_processor_events_failed_total:
    "Count of processor events that failed processing (labelled by `reason` / `retryable`).",
  polaris_processor_events_retry_total:
    "Count of processor events that re-entered the consumer through retry semantics.",
  polaris_processor_events_dlq_total: "Count of processor events routed to the dead-letter queue.",
  polaris_processor_outcome_total:
    "Count of processor decisions, labelled by `outcome` (a closed set per processor: the identity stage emits created/bound/merged/unidentified).",
  polaris_processor_events_skipped_total:
    "Count of events a processor acknowledged without acting on, by `reason`. " +
    "`processor_disabled` is the activation gate refusing a (project, environment) " +
    "an operator switched off — an operator decision, not a failure.",
  polaris_processor_lag_ms_last:
    "Most recently observed processor lag in milliseconds (per topic partition).",
  polaris_processor_handler_duration_ms_last:
    "Most recently observed processor per-message handler duration in milliseconds.",

  // -- destinations (libs/delivery/destinations/src/metrics.ts) ----
  polaris_destination_events_consumed_total:
    "Count of analytics.events messages consumed by a Polaris destination consumer.",
  polaris_destination_events_delivered_total:
    "Count of destination delivery attempts that the vendor accepted.",
  polaris_destination_events_dropped_total:
    "Count of destination deliveries dropped by the normalize step (labelled by `reason`).",
  polaris_destination_events_failed_total:
    "Count of destination delivery attempts that failed (labelled by `error_class`).",
  polaris_destination_events_dlq_total:
    "Count of destination deliveries routed to the dead-letter queue.",
  polaris_destination_events_retry_total: "Count of destination delivery retries.",
  polaris_destination_events_skipped_total:
    "Count of destination deliveries the mapper skipped (labelled by `reason`).",
  polaris_destination_events_deduped_total:
    "Count of destination deliveries the destination-side dedupe window short-circuited.",
  polaris_destination_replay_suppressed_total:
    "Count of replay messages the destination consumer suppressed via the opt-out policy.",
  polaris_destination_delivery_duration_ms_last:
    "Most recently observed destination delivery duration in milliseconds.",
  polaris_destination_rate_limit_wait_ms_last:
    "Most recently observed destination rate-limit lease wait in milliseconds.",
};

/**
 * Stable header for `/metrics` responses. Mirrors the value
 * `PROMETHEUS_CONTENT_TYPE` from `@polaris/runtime-service-bootstrap`; we
 * re-declare it here so the serializer's tests can assert on the literal
 * without taking a dep on the bootstrap package.
 */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8" as const;

/**
 * Convert a `MetricSample[]` from a Polaris in-memory registry into the
 * Prometheus text exposition format. Returns a single string ready to be
 * served as the body of a `/metrics` route response.
 *
 * Format per metric name (one block):
 *
 * ```text
 * # HELP <name> <help text>
 * # TYPE <name> counter|gauge
 * <name>{label="value",...} <number>
 * <name>{label="other"} <number>
 * ```
 *
 * Samples are grouped by name in insertion order of the first occurrence
 * (stable across calls because the registries' Maps preserve insertion
 * order). Labels within a sample line are sorted alphabetically.
 *
 * An empty input returns the empty string. A single trailing newline is
 * appended to the non-empty output — Prometheus accepts either, but the
 * trailing newline is the canonical shape.
 */
export function toPrometheusText(samples: ReadonlyArray<MetricSample>): string {
  if (samples.length === 0) return "";

  // Group samples by name while preserving first-occurrence order.
  const order: string[] = [];
  const byName = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    let bucket = byName.get(sample.name);
    if (bucket === undefined) {
      bucket = [];
      byName.set(sample.name, bucket);
      order.push(sample.name);
    }
    bucket.push(sample);
  }

  const lines: string[] = [];
  for (const name of order) {
    const help = HELP_TEXT[name] ?? "Polaris metric.";
    const type = metricTypeFor(name);
    lines.push(`# HELP ${name} ${escapeHelp(help)}`);
    lines.push(`# TYPE ${name} ${type}`);
    const bucket = byName.get(name);
    if (bucket === undefined) continue;
    for (const sample of bucket) {
      lines.push(renderSample(sample));
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Resolve the Prometheus metric type for a Polaris metric name by the
 * platform's naming convention. `_total` → counter, anything ending in
 * `_last` → gauge. The `_ms_last` duration suffix is just a `_last`
 * variant, so it's also a gauge.
 *
 * Exported for tests; production code shouldn't need to call this.
 */
export function metricTypeFor(name: string): "counter" | "gauge" {
  if (name.endsWith("_total")) return "counter";
  if (name.endsWith("_last")) return "gauge";
  // Polaris's vocabulary only has counters and gauges in v1. Treat any
  // unrecognised suffix as a gauge so a future histogram metric doesn't
  // accidentally fall under the counter type without a deliberate change
  // here.
  return "gauge";
}

function renderSample(sample: MetricSample): string {
  const labelString = renderLabels(sample.labels);
  const value = renderValue(sample.value);
  if (labelString === "") return `${sample.name} ${value}`;
  return `${sample.name}{${labelString}} ${value}`;
}

function renderLabels(labels: Readonly<Record<string, string | number>>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts: string[] = [];
  for (const key of keys) {
    const raw = labels[key];
    if (raw === undefined) continue;
    parts.push(`${key}="${escapeLabelValue(String(raw))}"`);
  }
  return parts.join(",");
}

/**
 * Escape a label value per the Prometheus text-format spec:
 *   `\` → `\\`, newline → `\n`, double-quote → `\"`. No other transforms.
 */
function escapeLabelValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === '"') {
      out += '\\"';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Escape a HELP comment per the spec: only `\` → `\\` and newline → `\n`.
 * Double-quote is NOT escaped in HELP — only in label values. This is
 * subtle and easy to get wrong; the spec is explicit.
 */
function escapeHelp(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "\n") {
      out += "\\n";
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Render a numeric sample value. Integers stay integers; floats round-trip
 * through `Number.prototype.toString()` which already handles +Inf, -Inf,
 * and NaN per the spec (`+Inf`, `-Inf`, `NaN`). `Number.isInteger()` is
 * the cheapest way to keep counter values like `42` from being rendered
 * as `42.0`.
 */
function renderValue(value: number): string {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return "NaN";
    return value > 0 ? "+Inf" : "-Inf";
  }
  if (Number.isInteger(value)) return value.toString(10);
  return value.toString();
}
