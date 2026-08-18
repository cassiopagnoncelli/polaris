# Polaris Alerts Index

> **Lag alerts, read this first.** `polaris_processor_lag_ms_last` had no
> emitter until the timer-driven reporter landed: `observeLagMs` existed with
> zero call sites, so the two rules below could not fire and the panels drew
> an empty series. They now receive a reading every 10 seconds per
> `(processor, family, partition)`. Their thresholds were chosen against no
> data at all, so treat the first two weeks as calibration rather than as a
> paging signal.


This page is the operator's "what fires when" cheat sheet. Every
Prometheus alert rule shipped under
[`infra/prometheus/rules/`](../../infra/prometheus/rules/) is listed
here with its severity, threshold, affected service, and runbook URL.

Binding architecture reference:
[Observability and Operations](../architecture/08-observability-and-operations.md).

The v1 default thresholds are pinned by
[`agents/pm/kanban/done/P10-005-alerts-and-incident-runbooks.md`](../../agents/pm/kanban/done/P10-005-alerts-and-incident-runbooks.md);
they start permissive enough to avoid alert fatigue on a fresh
deployment and are tightened after observed traffic. **Thresholds are
initial defaults subject to revision.**

The matching SLO posture lives at [`slos.md`](slos.md).

## Severity model

| Severity | Meaning |
|---|---|
| `page` | Wake the on-call. The system or a project's traffic is materially degraded. |
| `warn` | Visible in dashboards, opens a ticket, no page. The on-call investigates during business hours. |

Both severities ride on the `severity` label of every alert; the
Alertmanager routing tree consumes that label to decide who and how.

## Alert catalogue

| Alert | Severity | Service | Threshold | Runbook |
|---|---|---|---|---|
| `PolarisIngestionSchemaRejectionRate` | page | ingester-api | schema rejection rate >5% over 5 minutes (per `project_id`, `environment`) | [Ingestion Rejection Spike](runbook-ingestion-rejection-spike.md) |
| `PolarisIngestionForbiddenFieldRejectionRate` | page | ingester-api | forbidden-field rejection rate >1% over 5 minutes (per `project_id`, `environment`) | [Ingestion Rejection Spike](runbook-ingestion-rejection-spike.md) |
| `PolarisRabbitMQPublishFailureRate` | page | ingester-api | publish failure rate >0.5% over 1 minute | [RabbitMQ Publish Failures](runbook-rabbitmq-publish-failures.md) |
| `PolarisRabbitMQConsumerLagWarn` | warn | rabbitmq | `polaris_processor_lag_ms_last` >5 min for 5 min (any pivot) | [Processor Lag](runbook-processor-lag.md) |
| `PolarisRabbitMQConsumerLagPage` | page | rabbitmq | `polaris_processor_lag_ms_last` >15 min for 5 min (any pivot) | [Processor Lag](runbook-processor-lag.md) |
| `PolarisIdentityMergeBreakerTripped` | page | processor | identity merge-rate breaker refusing merges for 5 min | [Identity merge storm](runbook-identity-merge-storm.md) |
| `PolarisProcessorDLQGrowthWarn` | warn | processor | processor DLQ growth >100/min for 5 min | [DLQ Growth](runbook-dlq-growth.md) |
| `PolarisProcessorDLQGrowthPage` | page | processor | processor DLQ growth >1000/min for 5 min | [DLQ Growth](runbook-dlq-growth.md) |
| `PolarisDestinationDeliveryFailureRate` | page | destination | per-instance delivery failure rate >1% over 5 minutes | [Destination API Failure](runbook-destination-api-failure.md) |
| `PolarisDestinationDLQGrowth` | page | destination | per-instance DLQ growth >50/min for 5 min | [DLQ Growth](runbook-dlq-growth.md) |
| `PolarisClickHouseIngestionLagWarn` | warn | clickhouse | sink ingestion lag >2 min (per interface table) | [ClickHouse Ingestion Lag](runbook-clickhouse-ingestion-lag.md) |
| `PolarisClickHouseIngestionLagPage` | page | clickhouse | sink ingestion lag >10 min (per interface table) | [ClickHouse Ingestion Lag](runbook-clickhouse-ingestion-lag.md) |
| `PolarisClickHouseSinkRowsSkipped` | warn | clickhouse | sink skipping >1 message/min for 10 min | [ClickHouse Ingestion Lag](runbook-clickhouse-ingestion-lag.md) |
| `PolarisClickHouseMVFailure` | page | clickhouse | any materialized view in `failed` state | [ClickHouse Ingestion Lag](runbook-clickhouse-ingestion-lag.md) |
| `PolarisReplayJobStuck` | page | replay-coordinator | a `running` replay job makes no progress for 30 min | [Replay Stuck](runbook-replay-stuck.md) |
| `PolarisOperatorGateDenialRate` | warn | control-plane | operator gate denials sustained >5/min | [Replay Stuck](runbook-replay-stuck.md) |

Severity distribution: **10 page, 5 warn**, 15 alerts total.

## V1 metric coverage

All 15 alert rules now reference real metrics; none use a
`vector(0)` placeholder. The metrics close out as follows:

- **Ingester** (`PolarisRabbitMQPublishFailureRate`): emitted by
  `apps/ingester-api/src/metrics/registry.ts` via
  `polaris_ingest_publish_failed_total` /
  `polaris_ingest_publish_success_total` (MKEF1I9G).
- **ClickHouse** (`PolarisClickHouseIngestionLagWarn`/`...Page`,
  `PolarisClickHouseSinkRowsSkipped`): emitted by
  `async/warehouse/clickhouse-sink`. Lag and consumed-row series carry a
  `table` label, so the two ingestion paths — source events into
  `analytics_events_queue`, derived events into
  `analytics_processed_queue` — are alerted independently by the same
  `max by (table)` rules.
- **ClickHouse MVs** (`PolarisClickHouseMVFailure`): emitted by the
  clickhouse-sink, the only process that writes to ClickHouse. The
  poller queries `system.materialized_views` on a 30s cadence.
- **Operator gate** (`PolarisOperatorGateDenialRate`): emitted by
  `enforceProductionMutationGate` via the `OperatorGateMetricsSink`
  the control-plane API wires (2JZZXTMY).
- **Replay** (`PolarisReplayJobStuck`): emitted by the replay
  executor via the `ReplayExecutorMetricsSink` seam (3S3YY2PG).
  Caveat: the v1 CLI invocation has no `/metrics` endpoint, so the
  metric is in-process only. A long-running scraper component (e.g.
  a future replay-coordinator service or a `replay_jobs`-row poller
  in the control-plane API) is needed to surface the gauges to
  Prometheus. The metric names + alert expression are stable
  contracts; the scraper is a separate scope.

## Recording rules

The rate-ratio expressions referenced by the alerts are pre-computed
by [`infra/prometheus/rules/polaris.recording.yml`](../../infra/prometheus/rules/polaris.recording.yml).
They keep alert expressions readable and avoid re-deriving the same
ratio in multiple rules:

| Recording rule | Description |
|---|---|
| `polaris:ingest_batch_rejection_ratio:rate5m` | Per `(project_id, environment)`: ratio of rejected batches to total batch outcomes over 5 minutes |
| `polaris:ingest_schema_rejection_ratio:rate5m` | Schema-shape rejection share (`reason=~"schema_.*"`) |
| `polaris:ingest_forbidden_field_rejection_ratio:rate5m` | Forbidden-field rejection share |
| `polaris:processor_dlq_growth:rate1m` | Per processor: DLQ events/minute |
| `polaris:processor_consumed:rate5m` | Per processor: consumed throughput |
| `polaris:destination_delivery_failure_ratio:rate5m` | Per destination instance: failure share over 5 minutes |
| `polaris:destination_dlq_growth:rate1m` | Per destination instance: DLQ events/minute |

## Standard labels

Every alert carries:

| Label | Always present | Meaning |
|---|---|---|
| `severity` | yes | `page` or `warn` |
| `service` | yes | one of `ingester-api`, `rabbitmq`, `processor`, `destination`, `clickhouse`, `replay-coordinator`, `control-plane` |
| `team` | yes | `platform-data` (the Polaris on-call rotation) |
| `project_id` | when applicable | per-project pivot |
| `environment` | when applicable | `development` / `staging` / `production` |
| `processor_name`, `processor_version` | processor alerts | from the shared-processor metric labels |
| `vendor`, `consumer_version`, `destination_id` | destination alerts | the immutable destination-instance identity |
| `topic_family`, `concrete_topic`, `partition` | RabbitMQ-touching alerts | from the topic-family triple per P11-008 |

## Cross-references

- [SLOs](slos.md) — the latency / freshness targets these alerts
  defend.
- Runbooks: every alert links to one of the seven runbook files
  under `docs/operations/`.
- [Dashboards index](dashboards.md) — the P10-003 service-level
  Grafana dashboards (`polaris-ingestion`, `polaris-rabbitmq`,
  `polaris-processors`, `polaris-destinations`, `polaris-clickhouse`)
  are the visual companion to these alert rules; the per-project
  dashboards from P11-008 stay for project-level drilldown.
- [Logging](logging.md) — the Loki pipeline; LogQL queries
  referenced from the runbooks live in this guide.
- [DLQ Triage Runbook](dlq-triage-runbook.md) — the canonical
  operator playbook for DLQ inspection / classification / retry /
  resolution; `runbook-dlq-growth.md` is the alert entry point,
  this is the deep workflow.
- [Topic Isolation Cutover](topic-isolation-cutover.md) — sustained
  per-project warns are the cutover signal.
- [Destination DLQ Triage](destination-dlq-triage.md) — the
  destination-side detailed surface.
- [Secret Rotation](secret-rotation.md) — when `error_class='auth'`
  drives DLQ growth, secret rotation is the standard mitigation
  path.
