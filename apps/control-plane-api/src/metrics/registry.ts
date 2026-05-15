/**
 * In-process counter registry for the control-plane API.
 *
 * Shape mirrors `apps/ingester-api/src/metrics/registry.ts`. The
 * `getSamples` output is consumed by `@polaris/shared-metrics`'s
 * `toPrometheusText` serializer at scrape time.
 */
import {
  METRIC_OPERATOR_GATE_DENIED_TOTAL,
  type OperatorGateDenialLabels,
  type OperatorGateMetricsSink,
} from "@polaris/shared-control-plane";
import type { MetricSample } from "@polaris/shared-metrics";

export class ControlPlaneMetrics implements OperatorGateMetricsSink {
  private readonly counters = new Map<string, MetricSample>();

  incrementGateDenial(labels: OperatorGateDenialLabels): void {
    this.incrementByLabels(METRIC_OPERATOR_GATE_DENIED_TOTAL, {
      actor: labels.actor,
      reason: labels.reason,
    });
  }

  getCounter(name: string, labels: Readonly<Record<string, string | number>>): number {
    const key = sampleKey(name, labels);
    return this.counters.get(key)?.value ?? 0;
  }

  getSamples(): MetricSample[] {
    return Array.from(this.counters.values()).map((sample) => ({
      name: sample.name,
      labels: { ...sample.labels },
      value: sample.value,
    }));
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
