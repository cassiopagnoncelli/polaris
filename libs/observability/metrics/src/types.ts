/**
 * Sample shape emitted by Polaris's in-memory metric registries.
 *
 * Mirrors the `MetricSample` interface declared identically in
 * `apps/ingester-api/src/metrics/registry.ts`,
 * `libs/pipeline/src/metrics.ts`, and
 * `libs/delivery/destinations/src/metrics.ts`. Each registry owns its
 * own copy so it doesn't take a runtime dep on this package; this
 * declaration is the canonical contract every registry implements.
 *
 * When a registry adds a new metric type in the future, it must continue
 * to expose samples in this shape so the serializer in `./prometheus.ts`
 * keeps working without a cross-package refactor.
 */
export interface MetricSample {
  /**
   * Fully-qualified metric name, e.g. `polaris_ingest_batch_accepted_total`.
   * Polaris uses the convention `polaris_<subsystem>_<noun>_total` for
   * counters and `polaris_<subsystem>_<noun>_last` (or
   * `polaris_<subsystem>_<noun>_ms_last`) for gauges.
   */
  readonly name: string;
  /**
   * Label key/value pairs. Polaris's registries deliberately keep
   * cardinality bounded: project_id, environment, vendor, source_id,
   * event name, reason code, status. Never event_id, user_id, request_id,
   * or other unbounded user-supplied strings.
   */
  readonly labels: Readonly<Record<string, string | number>>;
  /** Counter or gauge value. */
  readonly value: number;
}
