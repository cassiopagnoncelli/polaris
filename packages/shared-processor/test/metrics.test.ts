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

  it("getSamples returns a stable snapshot of counters and gauges", () => {
    const m = new ProcessorMetrics();
    m.incrementConsumed(LABELS);
    m.observeLagMs(LABELS, 100);
    const samples = m.getSamples();
    const names = samples.map((s) => s.name).sort();
    expect(names).toEqual([METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL, METRIC_PROCESSOR_LAG_MS_LAST]);
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
