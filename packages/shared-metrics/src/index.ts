/**
 * `@polaris/shared-metrics` — Prometheus exposition for Polaris's in-process
 * metric registries.
 *
 * The three subsystem registries (`IngestMetrics`, `ProcessorMetrics`,
 * `DestinationMetrics`) all expose `getSamples(): MetricSample[]`. Wire
 * the snapshot into `bootstrapService({ metrics: { producer: () =>
 * toPrometheusText(registry.getSamples()) } })` and the service's
 * `/metrics` route will start serving real Prometheus text instead of the
 * empty stub.
 *
 * @see docs/architecture/08-observability-and-operations.md
 * @see docs/implementation/tasks/P10-002-metrics-standardization.md
 */
export { metricTypeFor, PROMETHEUS_CONTENT_TYPE, toPrometheusText } from "./prometheus.js";
export type { MetricSample } from "./types.js";
