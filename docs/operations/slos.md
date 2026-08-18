# Polaris Service Level Objectives

This page documents the v1 default service level objectives Polaris
operates against. **SLOs are operational targets, not contractual
SLAs**; burn-rate alerts come later, after observed traffic
establishes a baseline.

Binding architecture reference:
[Observability and Operations](../architecture/08-observability-and-operations.md).

The v1 SLO targets are pinned by
`agents/pm/kanban/done/P10-005-alerts-and-incident-runbooks.md`;
this page is the operator-facing source of truth and is **subject to
revision** as traffic patterns establish a baseline.

The matching alerts catalogue lives at [`alerts.md`](alerts.md).

## V1 SLO targets

| Surface | Measurement | v1 target | Metric / panel |
|---|---|---|---|
| Ingester accept latency | p99 over 5 min | 200 ms | `polaris_ingest_*` latency histograms; future Grafana panel under `infra/grafana/dashboards/` |
| Ingester accept latency | p999 over 5 min | 500 ms | same |
| End-to-end raw → analytics | p99 over 5 min | 60 s | `polaris_processor_lag_ms_last` chained to ClickHouse ingestion freshness; the Grafana per-project consumer-lag dashboard (UID `polaris-per-project-lag`) is the operator surface today |
| Destination delivery latency | vendor-specific | documented per consumer | `polaris_destination_delivery_duration_ms_last` |

## Why these numbers

The v1 targets are conservative defaults that anchor operator
intuition and give the alerts catalogue a frame of reference. They
are not derived from contractual obligations:

- **200 ms p99 / 500 ms p999 ingester accept latency** mirrors the
  budget the SDK retry contract was designed around (see
  [`docs/sdk/initialization.md`](../sdk/initialization.md)). An
  ingester that breaches these latencies measurably degrades the
  experience downstream of the SDK.
- **60 s p99 raw → analytics** is the freshness commitment the
  analytics dashboards lean on. Anything slower starts surfacing
  noticeably-stale numbers in operator-facing analytical queries.
- **Vendor-specific destination latency** is documented per
  destination consumer because the upstream vendor's API latency
  determines what is achievable. Each destination's README documents
  the achievable p99 for its vendor.

## What SLOs are NOT

- **Not SLAs.** Polaris is internal event infrastructure. The SLOs
  here are operational targets for the on-call rotation; no
  contractual penalty attaches to a missed SLO.
- **Not burn-rate alerted yet.** The v1 alerts catalogue uses
  threshold-on-rate alerts (e.g. "lag >15 min for 5 min") rather
  than budget burn-rate alerts. Burn-rate alerting requires:
  (a) a stable error budget definition,
  (b) a SLI recording rule per SLO surface,
  (c) Alertmanager routing tuned for fast / slow burn windows.
  Tracked as future work; the v1 thresholds protect availability
  without it.
- **Not a freshness contract** for downstream projection tables.
  Projection tables that derive from `analytics_raw` may have
  longer freshness windows by design — see
  [`docs/architecture/07-clickhouse.md`](../architecture/07-clickhouse.md).

## How SLOs map to alerts

The v1 alerts catalogue defends the SLO surfaces, not the SLO
numbers directly:

| SLO surface | Defending alert(s) |
|---|---|
| Ingester accept latency | `PolarisRabbitMQPublishFailureRate` (publish failures dominate the p999 tail); `PolarisIngestionSchemaRejectionRate` (rejection-storm CPU pressure climbs the latency tail) |
| End-to-end raw → analytics | `PolarisRabbitMQConsumerLagWarn` / `Page`; `PolarisProcessorDLQGrowthWarn` / `Page`; `PolarisClickHouseIngestionLagWarn` / `Page` |
| Destination delivery latency | `PolarisDestinationDeliveryFailureRate`; `PolarisDestinationDLQGrowth` |

When burn-rate alerts land, the mapping flips: each SLO surface gets
its own burn-rate alert pair (fast burn, slow burn) and the
threshold-on-rate alerts above stay as supplementary signals.

## Cross-references

- [Alerts index](alerts.md) — every alert with its threshold and
  the runbook URL.
- [Observability and Operations](../architecture/08-observability-and-operations.md) —
  the canonical observability posture.
- [ClickHouse](../architecture/07-clickhouse.md) — the
  projection-table freshness model.
- [Topic Isolation Cutover](topic-isolation-cutover.md) — when
  sustained per-project SLO violation is the cutover signal.
