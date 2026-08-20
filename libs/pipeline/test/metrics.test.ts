/**
 * Tests for `ProcessorMetrics`.
 *
 * Mirrors the shape of the `IngestMetrics` tests: a tiny in-memory
 * registry with deterministic increment/observation semantics.
 */
import { describe, expect, it } from "vitest";

import {
  METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL,
  METRIC_PROCESSOR_EVENTS_DLQ_TOTAL,
  METRIC_PROCESSOR_EVENTS_EMITTED_TOTAL,
  METRIC_PROCESSOR_EVENTS_FAILED_TOTAL,
  METRIC_PROCESSOR_EVENTS_RETRY_TOTAL,
  METRIC_PROCESSOR_HANDLER_DURATION_MS_LAST,
  METRIC_PROCESSOR_LAG_MS_LAST,
  ProcessorMetrics,
} from "../src/metrics.js";

const LABELS = {
  processor_name: "analytics-projector",
  processor_version: "v1",
  project_id: "checkout",
  environment: "production",
};

describe("ProcessorMetrics", () => {
  it("increments counters per label tuple", () => {
    const m = new ProcessorMetrics();
    m.incrementConsumed(LABELS);
    m.incrementConsumed(LABELS);
    m.incrementEmitted(LABELS);
    expect(m.getCounter(METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL, LABELS)).toBe(2);
    expect(m.getCounter(METRIC_PROCESSOR_EVENTS_EMITTED_TOTAL, LABELS)).toBe(1);
  });

  it("keeps separate counters per distinct label tuple", () => {
    const m = new ProcessorMetrics();
    m.incrementConsumed(LABELS);
    m.incrementConsumed({ ...LABELS, environment: "staging" });
    expect(m.getCounter(METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL, LABELS)).toBe(1);
    expect(
      m.getCounter(METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL, { ...LABELS, environment: "staging" }),
    ).toBe(1);
  });

  it("records failure and DLQ counters with the reason label", () => {
    const m = new ProcessorMetrics();
    m.incrementFailed({ ...LABELS, reason: "decode_failed" });
    m.incrementDlq({ ...LABELS, reason: "decode_failed" });
    m.incrementRetry({ ...LABELS, reason: "network_error" });
    expect(
      m.getCounter(METRIC_PROCESSOR_EVENTS_FAILED_TOTAL, {
        ...LABELS,
        reason: "decode_failed",
      }),
    ).toBe(1);
    expect(
      m.getCounter(METRIC_PROCESSOR_EVENTS_DLQ_TOTAL, {
        ...LABELS,
        reason: "decode_failed",
      }),
    ).toBe(1);
    expect(
      m.getCounter(METRIC_PROCESSOR_EVENTS_RETRY_TOTAL, {
        ...LABELS,
        reason: "network_error",
      }),
    ).toBe(1);
  });

  it("observes lag and handler duration as last-seen gauges", () => {
    const m = new ProcessorMetrics();
    m.observeLagMs(LABELS, 100);
    m.observeLagMs(LABELS, 250);
    m.observeHandlerDurationMs(LABELS, 5);
    expect(m.getGauge(METRIC_PROCESSOR_LAG_MS_LAST, LABELS)).toBe(250);
    expect(m.getGauge(METRIC_PROCESSOR_HANDLER_DURATION_MS_LAST, LABELS)).toBe(5);
  });

  it("getSamples returns a stable snapshot of counters, gauges, and histogram series", () => {
    const m = new ProcessorMetrics();
    m.incrementConsumed(LABELS);
    m.observeLagMs(LABELS, 100);
    const names = new Set(m.getSamples().map((s) => s.name));
    expect(names.has(METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL)).toBe(true);
    expect(names.has(METRIC_PROCESSOR_LAG_MS_LAST)).toBe(true);
    // CSH8YAL6: `observeLagMs` now also feeds the `*_seconds` histogram.
    // `getSamples()` emits the canonical Prometheus families (`_bucket`,
    // `_sum`, `_count`); assert at least one bucket variant is present.
    const hasHistogramBucket = [...names].some((n) => n.endsWith("_bucket"));
    const hasHistogramSum = [...names].some((n) => n.endsWith("_sum"));
    const hasHistogramCount = [...names].some((n) => n.endsWith("_count"));
    expect(hasHistogramBucket).toBe(true);
    expect(hasHistogramSum).toBe(true);
    expect(hasHistogramCount).toBe(true);
  });

  it("reset clears all counters and gauges", () => {
    const m = new ProcessorMetrics();
    m.incrementConsumed(LABELS);
    m.observeLagMs(LABELS, 100);
    m.reset();
    expect(m.getSamples()).toEqual([]);
    expect(m.getCounter(METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL, LABELS)).toBe(0);
    expect(m.getGauge(METRIC_PROCESSOR_LAG_MS_LAST, LABELS)).toBeUndefined();
  });
});

describe("outcome counter", () => {
  it("records decisions separately from emissions", () => {
    // A merge and an ordinary bind both emit exactly one spine event, so
    // `emitted` cannot tell them apart — and a merge storm is the failure
    // mode the identity safeguards exist to catch.
    const metrics = new ProcessorMetrics();
    const identity = { processor_name: "sync-identity-resolver", processor_version: "v1" };

    metrics.incrementOutcome({ ...identity, outcome: "created" });
    metrics.incrementOutcome({ ...identity, outcome: "merged" });
    metrics.incrementOutcome({ ...identity, outcome: "merged" });

    const samples = metrics
      .getSamples()
      .filter((sample) => sample.name === "polaris_processor_outcome_total");
    const byOutcome = new Map(samples.map((s) => [s.labels["outcome"], s.value]));
    expect(byOutcome.get("created")).toBe(1);
    expect(byOutcome.get("merged")).toBe(2);
  });

  it("keeps outcomes apart per processor, so one dashboard can hold both stages", () => {
    const metrics = new ProcessorMetrics();
    metrics.incrementOutcome({
      processor_name: "sync-identity-resolver",
      processor_version: "v1",
      outcome: "bound",
    });
    metrics.incrementOutcome({
      processor_name: "sync-enrichment-runtime",
      processor_version: "v1",
      outcome: "traits:resolved",
    });

    const samples = metrics
      .getSamples()
      .filter((sample) => sample.name === "polaris_processor_outcome_total");
    expect(samples).toHaveLength(2);
    expect(new Set(samples.map((s) => s.labels["processor_name"]))).toEqual(
      new Set(["sync-identity-resolver", "sync-enrichment-runtime"]),
    );
  });
});
