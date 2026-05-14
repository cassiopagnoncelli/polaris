/**
 * In-process counter registry for the control-plane API.
 *
 * P6-000 ships the shell with no business counters yet — every
 * mutating route's audit + gate is the audit layer's job, not the
 * metric layer's. The registry stays here so subsequent P6 tasks add
 * counters without re-wiring `/metrics`.
 *
 * Shape mirrors `apps/ingester-api/src/metrics/registry.ts`. The
 * `getSamples` output is consumed by `@polaris/shared-metrics`'s
 * `toPrometheusText` serializer at scrape time.
 */
import type { MetricSample } from "@polaris/shared-metrics";

export class ControlPlaneMetrics {
  private readonly counters = new Map<string, MetricSample>();

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
}
