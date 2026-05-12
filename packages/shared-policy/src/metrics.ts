import type { Logger } from "@polaris/shared-logger";

import type { PolicyReasonCode } from "./reason-codes.js";
import type { RedactionAction } from "./types.js";

/**
 * Metric name emitted for every pattern-based redaction.
 *
 * The label set is fixed:
 *
 *   - `project_id`   from the canonical envelope
 *   - `environment`  from the canonical envelope
 *   - `reason`       closed-set policy reason code
 *   - `pattern`      stable detector tag (e.g. `luhn_pan`, `jwt`)
 *
 * The label set explicitly **does not** include the redacted value, the
 * field path, or any value-derived label. Pattern label cardinality is
 * bounded by the number of registered detectors; the others are bounded
 * by project_id × environment × |reasons| which stays well below alerting
 * thresholds.
 *
 * @see docs/architecture/01-event-contract.md "Redact list (pattern-based)"
 * @see docs/architecture/08-observability-and-operations.md
 */
export const POLARIS_INGEST_REDACTED_PATTERN_TOTAL = "polaris_ingest_redacted_pattern_total";

/**
 * Label set for `polaris_ingest_redacted_pattern_total`.
 *
 * Exposed as a typed shape so callers using a typed metric registry
 * (Prometheus / OTEL) can construct counters with the canonical labels.
 */
export interface PatternRedactionMetricLabels {
  readonly project_id: string;
  readonly environment: string;
  readonly reason: PolicyReasonCode;
  readonly pattern: string;
}

/**
 * Counter increment payload — what `recordPatternRedaction` produces.
 *
 * Returned as a value (not invoked) so callers can plumb it into any
 * metric backend without this package taking a hard dependency on a
 * Prometheus client.
 */
export interface PatternRedactionMetricIncrement {
  readonly name: typeof POLARIS_INGEST_REDACTED_PATTERN_TOTAL;
  readonly labels: PatternRedactionMetricLabels;
  readonly value: 1;
}

/**
 * Identity envelope context the metric/log helper requires. Pull this
 * straight from the canonical envelope; it is stamped by the ingester
 * from the API key.
 */
export interface RedactionEmissionContext {
  readonly project_id: string;
  readonly environment: string;
}

/**
 * Optional dependencies for `emitRedactionMetric`. A caller normally
 * wires a Prometheus counter or OTEL meter through `incrementCounter` and
 * a `@polaris/shared-logger` instance through `logger`.
 *
 * The helper logs at the `debug` level and never includes the raw value.
 * Label-only logging keeps the per-event log volume bounded.
 */
export interface RedactionEmissionDeps {
  readonly incrementCounter?: (increment: PatternRedactionMetricIncrement) => void;
  readonly logger?: Pick<Logger, "debug">;
}

/**
 * Emit the redaction metric and (optionally) a structured debug log line
 * for a single pattern-based redaction.
 *
 * The helper enforces the safety invariants required by the architecture:
 *
 *   - the redacted value is **never** part of the metric labels or log fields
 *   - the field path is included as a structured `path` array on the debug
 *     log so operators can locate the producer leak, but not on the metric
 *     (cardinality)
 *   - only pattern-based redactions are emitted; named-field redactions
 *     do not produce per-event metrics (their volume is producer-driven
 *     and would balloon cardinality without a clear operational use)
 */
export function emitRedactionMetric(
  action: RedactionAction,
  context: RedactionEmissionContext,
  deps: RedactionEmissionDeps = {},
): PatternRedactionMetricIncrement | undefined {
  if (action.source !== "pattern" || !action.pattern) {
    return undefined;
  }
  const increment: PatternRedactionMetricIncrement = {
    name: POLARIS_INGEST_REDACTED_PATTERN_TOTAL,
    labels: {
      project_id: context.project_id,
      environment: context.environment,
      reason: action.reason,
      pattern: action.pattern,
    },
    value: 1,
  };
  deps.incrementCounter?.(increment);
  deps.logger?.debug(
    {
      metric: increment.name,
      labels: increment.labels,
      path: action.path,
    },
    "pattern-based redaction applied",
  );
  return increment;
}

/**
 * Convenience over a `decision.redactions` list. Walks the redactions,
 * emits metrics for every pattern-based entry, and returns the increments
 * that fired. Callers can use this when they want a single call site at
 * the boundary instead of looping the redaction array themselves.
 */
export function emitAllRedactionMetrics(
  redactions: readonly RedactionAction[],
  context: RedactionEmissionContext,
  deps: RedactionEmissionDeps = {},
): PatternRedactionMetricIncrement[] {
  const out: PatternRedactionMetricIncrement[] = [];
  for (const action of redactions) {
    const increment = emitRedactionMetric(action, context, deps);
    if (increment) out.push(increment);
  }
  return out;
}
