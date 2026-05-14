/**
 * Behavioral tests for the Prometheus text-format serializer.
 *
 * The shape is small but every detail matters: a wrong escape, a wrong
 * type hint, or a wrong label order can be invisible until a Prometheus
 * scrape rejects the body — at which point an observability outage looks
 * like a Polaris outage. These tests pin the spec-relevant edges.
 *
 * @see docs/implementation/tasks/P10-002-metrics-standardization.md
 */

import { describe, expect, it } from "vitest";

import {
  metricTypeFor,
  PROMETHEUS_CONTENT_TYPE,
  toPrometheusText,
  type MetricSample,
} from "../src/index.js";

describe("toPrometheusText", () => {
  it("returns the empty string for an empty registry", () => {
    expect(toPrometheusText([])).toBe("");
  });

  it("emits HELP + TYPE + one sample line for a single counter", () => {
    const samples: MetricSample[] = [
      {
        name: "polaris_ingest_batch_accepted_total",
        labels: { project_id: "storefront", environment: "production" },
        value: 42,
      },
    ];
    const text = toPrometheusText(samples);
    expect(text).toContain("# HELP polaris_ingest_batch_accepted_total");
    expect(text).toContain("# TYPE polaris_ingest_batch_accepted_total counter");
    expect(text).toMatch(
      /polaris_ingest_batch_accepted_total\{environment="production",project_id="storefront"\} 42/,
    );
    expect(text.endsWith("\n")).toBe(true);
  });

  it("emits TYPE=gauge for `_last`-suffixed metrics", () => {
    const samples: MetricSample[] = [
      {
        name: "polaris_processor_handler_duration_ms_last",
        labels: { name: "analytics-projector", version: "v1" },
        value: 12.5,
      },
    ];
    const text = toPrometheusText(samples);
    expect(text).toContain("# TYPE polaris_processor_handler_duration_ms_last gauge");
    expect(text).toContain("12.5");
  });

  it("groups multiple samples that share a name under one HELP+TYPE block", () => {
    const samples: MetricSample[] = [
      {
        name: "polaris_ingest_batch_rejected_total",
        labels: { project_id: "p1", environment: "production", reason: "forbidden_field_rejected" },
        value: 3,
      },
      {
        name: "polaris_ingest_batch_rejected_total",
        labels: { project_id: "p1", environment: "production", reason: "schema_validation_failed" },
        value: 7,
      },
    ];
    const text = toPrometheusText(samples);
    const helpCount = (text.match(/# HELP polaris_ingest_batch_rejected_total/g) ?? []).length;
    const typeCount = (text.match(/# TYPE polaris_ingest_batch_rejected_total/g) ?? []).length;
    expect(helpCount).toBe(1);
    expect(typeCount).toBe(1);
    expect(text).toContain('reason="forbidden_field_rejected"');
    expect(text).toContain('reason="schema_validation_failed"');
  });

  it("sorts labels alphabetically within each sample line for diff stability", () => {
    const samples: MetricSample[] = [
      {
        name: "polaris_ingest_batch_accepted_total",
        // Insert in non-alphabetical order on purpose.
        labels: { z_last: "z", a_first: "a", m_mid: "m" },
        value: 1,
      },
    ];
    const text = toPrometheusText(samples);
    expect(text).toMatch(/\{a_first="a",m_mid="m",z_last="z"\}/);
  });

  it("escapes backslash, newline, and double-quote in label values per the spec", () => {
    const samples: MetricSample[] = [
      {
        name: "polaris_ingest_batch_rejected_total",
        labels: {
          // All three escapable chars in one label value.
          reason: 'bad "value" with\nnewline and \\ backslash',
        },
        value: 1,
      },
    ];
    const text = toPrometheusText(samples);
    expect(text).toContain('reason="bad \\"value\\" with\\nnewline and \\\\ backslash"');
  });

  it("does not escape double-quote in HELP comments (only label values get that)", () => {
    // We can't easily inject a custom HELP, so we use a metric name not in
    // the HELP table and rely on the default ("Polaris metric."). The
    // assertion is structural: the HELP line is rendered without applying
    // the label-value escape rules.
    const samples: MetricSample[] = [
      {
        name: "polaris_unknown_metric_total",
        labels: {},
        value: 0,
      },
    ];
    const text = toPrometheusText(samples);
    expect(text).toContain("# HELP polaris_unknown_metric_total Polaris metric.");
  });

  it("renders a sample without labels using the no-braces shape", () => {
    const samples: MetricSample[] = [
      { name: "polaris_processor_lag_ms_last", labels: {}, value: 0 },
    ];
    const text = toPrometheusText(samples);
    // No `{}` block when the label set is empty.
    expect(text).toMatch(/^# HELP polaris_processor_lag_ms_last/);
    expect(text).toContain("\npolaris_processor_lag_ms_last 0\n");
    expect(text).not.toContain("polaris_processor_lag_ms_last{}");
  });

  it("renders integers as integers (no `.0`) and floats with .toString()", () => {
    const samples: MetricSample[] = [
      { name: "polaris_ingest_batch_accepted_total", labels: { project_id: "p" }, value: 42 },
      { name: "polaris_processor_lag_ms_last", labels: { name: "x", version: "v1" }, value: 3.14 },
    ];
    const text = toPrometheusText(samples);
    expect(text).toMatch(/polaris_ingest_batch_accepted_total\{project_id="p"\} 42$/m);
    expect(text).toMatch(/polaris_processor_lag_ms_last\{name="x",version="v1"\} 3.14$/m);
  });

  it("renders Infinity, -Infinity, and NaN per the spec", () => {
    const samples: MetricSample[] = [
      {
        name: "polaris_processor_lag_ms_last",
        labels: { tag: "pos" },
        value: Number.POSITIVE_INFINITY,
      },
      {
        name: "polaris_processor_lag_ms_last",
        labels: { tag: "neg" },
        value: Number.NEGATIVE_INFINITY,
      },
      { name: "polaris_processor_lag_ms_last", labels: { tag: "nan" }, value: Number.NaN },
    ];
    const text = toPrometheusText(samples);
    expect(text).toContain('polaris_processor_lag_ms_last{tag="pos"} +Inf');
    expect(text).toContain('polaris_processor_lag_ms_last{tag="neg"} -Inf');
    expect(text).toContain('polaris_processor_lag_ms_last{tag="nan"} NaN');
  });

  it("preserves first-occurrence order of metric names across the output", () => {
    const samples: MetricSample[] = [
      { name: "polaris_processor_events_consumed_total", labels: {}, value: 1 },
      { name: "polaris_ingest_batch_accepted_total", labels: {}, value: 2 },
      { name: "polaris_processor_events_consumed_total", labels: { x: "1" }, value: 3 },
    ];
    const text = toPrometheusText(samples);
    const consumedIdx = text.indexOf("# HELP polaris_processor_events_consumed_total");
    const acceptedIdx = text.indexOf("# HELP polaris_ingest_batch_accepted_total");
    expect(consumedIdx).toBeGreaterThanOrEqual(0);
    expect(acceptedIdx).toBeGreaterThanOrEqual(0);
    expect(consumedIdx).toBeLessThan(acceptedIdx);
  });

  it("accepts numeric label values and coerces them to strings", () => {
    const samples: MetricSample[] = [
      {
        name: "polaris_ingest_batch_accepted_total",
        labels: { schema_version: 2, project_id: "p1" },
        value: 1,
      },
    ];
    const text = toPrometheusText(samples);
    expect(text).toMatch(/project_id="p1",schema_version="2"/);
  });
});

describe("metricTypeFor", () => {
  it("returns 'counter' for `_total` suffix", () => {
    expect(metricTypeFor("polaris_ingest_batch_accepted_total")).toBe("counter");
    expect(metricTypeFor("polaris_destination_events_delivered_total")).toBe("counter");
  });

  it("returns 'gauge' for `_last` suffix", () => {
    expect(metricTypeFor("polaris_processor_lag_ms_last")).toBe("gauge");
    expect(metricTypeFor("polaris_destination_delivery_duration_ms_last")).toBe("gauge");
  });

  it("returns 'gauge' as the safe default for unrecognised suffixes", () => {
    // Forward-compatibility: a future histogram metric must not be
    // silently classified as a counter.
    expect(metricTypeFor("polaris_processor_handler_duration_seconds")).toBe("gauge");
  });
});

describe("PROMETHEUS_CONTENT_TYPE", () => {
  it("matches the spec-canonical text/plain version", () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
