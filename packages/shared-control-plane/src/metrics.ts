/**
 * Metric contract for the operator gate.
 *
 * The gate itself stays pure — it doesn't pull in a metrics dependency
 * directly. Callers wire a {@link OperatorGateMetricsSink} into the
 * gate input; the gate calls `incrementGateDenial` on every refusal
 * before throwing.
 *
 * The metric is consumed by the `PolarisOperatorGateDenialRate` warn
 * alert (sustained >5/min suggests credential confusion or a script
 * wielding stale tokens). See `docs/operations/alerts.md`.
 */

export const METRIC_OPERATOR_GATE_DENIED_TOTAL = "polaris_operator_gate_denied_total";

export interface OperatorGateDenialLabels {
  readonly actor: string;
  readonly reason: string;
}

export interface OperatorGateMetricsSink {
  incrementGateDenial(labels: OperatorGateDenialLabels): void;
}
