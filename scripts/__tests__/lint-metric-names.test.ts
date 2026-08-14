/**
 * `scripts/lint-metric-names.mjs`.
 *
 * These tests pin the two properties that decide whether the check is useful
 * or noise: a panel naming a metric the code emits must NOT be reported, and
 * a panel naming one nothing emits MUST be.
 *
 * The false-negative half matters as much as the other. The first draft of
 * this check was stricter — it demanded the metric's constant be handed to an
 * `increment*` call — and flagged four working ClickHouse panels, because the
 * sink emits by building sample objects rather than by calling a counter. A
 * check that reports healthy panels gets switched off, so the tests below
 * cover both emission shapes deliberately.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs script, no type declarations by design.
import { findMetricNameProblems } from "../lint-metric-names.mjs";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-metric-names-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function dashboard(expr: string, title = "A panel"): void {
  seed(
    "infra/grafana/dashboards/test.json",
    JSON.stringify({ panels: [{ title, targets: [{ expr }] }] }),
  );
}

function names(): string[] {
  return findMetricNameProblems(root).problems.map((p: { name: string }) => p.name);
}

describe("findMetricNameProblems", () => {
  it("reports a panel naming a metric no source declares", () => {
    seed("packages/m/src/metrics.ts", 'export const A = "polaris_thing_total";\n');
    dashboard('sum(rate(polaris_typo_total{environment="production"}[5m]))');
    expect(names()).toEqual(["polaris_typo_total"]);
  });

  it("accepts a metric declared as a constant and handed to a counter", () => {
    seed(
      "packages/m/src/metrics.ts",
      'export const A = "polaris_thing_total";\nclass R { go() { this.incrementByLabels(A, {}); } }\n',
    );
    dashboard("sum(rate(polaris_thing_total[5m]))");
    expect(names()).toEqual([]);
  });

  it("accepts a metric emitted by building a sample object", () => {
    // The ClickHouse sink's shape. The stricter first draft failed here and
    // reported four working panels.
    seed(
      "async/w/src/metrics.ts",
      'const A = "polaris_sink_rows_total";\nfunction getSamples() { return [{ name: A, labels: {}, value: 1 }]; }\n',
    );
    dashboard("sum(rate(polaris_sink_rows_total[5m]))");
    expect(names()).toEqual([]);
  });

  it("resolves histogram suffixes against the emitted base name", () => {
    // Prometheus exposes a histogram as three series; only the base is
    // declared in source, and a p99 panel legitimately queries `_bucket`.
    seed("packages/m/src/metrics.ts", 'export const A = "polaris_latency_seconds";\n');
    dashboard("histogram_quantile(0.99, sum by (le) (rate(polaris_latency_seconds_bucket[5m])))");
    expect(names()).toEqual([]);
  });

  it("accepts a recording rule as a definition, and checks its own expression", () => {
    seed("packages/m/src/metrics.ts", 'export const A = "polaris_thing_total";\n');
    seed(
      "infra/prometheus/rules/rec.yml",
      "groups:\n  - name: g\n    rules:\n      - record: polaris:thing:rate1m\n        expr: |\n          sum(rate(polaris_thing_total[1m]))\n",
    );
    seed(
      "infra/prometheus/rules/alerts.yml",
      "groups:\n  - name: g\n    rules:\n      - alert: Thing\n        expr: polaris:thing:rate1m > 0\n",
    );
    expect(names()).toEqual([]);
  });

  it("reports a recording rule built on a metric nothing emits", () => {
    // The indirection must not become a laundering step.
    seed("packages/m/src/metrics.ts", 'export const A = "polaris_thing_total";\n');
    seed(
      "infra/prometheus/rules/rec.yml",
      "groups:\n  - name: g\n    rules:\n      - record: polaris:ghost:rate1m\n        expr: |\n          sum(rate(polaris_ghost_total[1m]))\n",
    );
    expect(names()).toEqual(["polaris_ghost_total"]);
  });

  it("ignores metrics another exporter owns", () => {
    seed("packages/m/src/metrics.ts", 'export const A = "polaris_thing_total";\n');
    dashboard("sum(rate(rabbitmq_queue_messages[5m])) + up");
    expect(names()).toEqual([]);
  });

  it("ignores label names and PromQL functions", () => {
    // `environment`, `sum`, `rate` and `le` all match an identifier regex;
    // only `polaris_*` names are candidates.
    seed("packages/m/src/metrics.ts", 'export const A = "polaris_thing_total";\n');
    dashboard('sum by (environment, project_id) (rate(polaris_thing_total{job="x"}[5m]))');
    expect(names()).toEqual([]);
  });
});
