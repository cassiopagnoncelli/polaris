# Redpanda Publish Failures Runbook

Operators use this runbook when the ingester-api or a processor's
emitter is failing to publish to Redpanda at a rate that breaches the
v1 default threshold of 0.5% over one minute.

Binding architecture references:

- [Redpanda Topics](../architecture/03-redpanda-topics.md)
- [Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)

The ingester publisher lives at
[`apps/ingester-api/`](../../apps/ingester-api/). The shared Kafka
client lives at
[`packages/shared-kafka/`](../../packages/shared-kafka/). The
Prometheus rule that triggers this runbook lives at
[`infra/prometheus/rules/polaris.alerts.yml`](../../infra/prometheus/rules/polaris.alerts.yml).

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisRedpandaPublishFailureRate` | page | publish failure share >0.5% over 1 minute |

**v1 metric gap.** The publish-failure counter
`polaris_ingest_publish_failed_total` does not exist yet. The alert
is wired with the v1 threshold and will not fire until the ingester
publisher emits the counter; the gap is tracked in
[`docs/operations/alerts.md`](alerts.md). Until then, operators rely
on Redpanda-side metrics (`vectorized_kafka_rpc_errors_total`,
broker logs) and the ingester's structured logs to spot the failure
mode.

## Symptoms

- Ingester logs show `event="kafka.publish.error"` or
  `event="kafka.publish.retry"` at elevated rates.
- Broker-side Redpanda metrics show RPC errors, leader-election
  storms, or controller leadership churn.
- Producer-side latency on the ingest endpoint climbs while the CPU
  on the ingester pod stays flat — the publish is the bottleneck.
- `polaris_ingest_batch_rejected_total{reason="publish_failed"}` may
  surface if the ingester surfaces publish failures back to the
  caller (rather than retrying internally).

## Probable causes, ranked

1. **Broker unavailable.** A Redpanda broker is down (rolling
   restart, node failure, network partition). Symptoms cluster on one
   broker id.
2. **Quota / throttle from the broker.** Sustained throughput against
   a topic exceeded the configured per-producer quota. Errors carry
   `THROTTLING_QUOTA_EXCEEDED` or equivalent.
3. **Leader election storm.** A topic's partition leaders are
   flapping; producers re-resolve continuously and many writes time
   out. Often correlated with broker restarts or network instability.
4. **Topic missing or mis-named.** The producer is writing to a topic
   the broker doesn't have — usually a config or topic-resolution bug
   after a deploy or after a `polaris topics isolate` cutover.
5. **Publisher mis-configured.** The ingester has stale broker
   endpoints in `POLARIS_REDPANDA_BROKERS` after a broker IP change;
   reload required.
6. **Disk full on broker.** Redpanda is rejecting writes because the
   data volume is at capacity (rare, but happens when retention or
   tiered-storage upload falls behind).

## Investigation

### 1. Confirm broker health

```bash
docker compose exec polaris-redpanda \
  rpk cluster health
```

`rpk cluster health` reports leader election status, broker membership,
and per-partition leadership. Anything other than "Healthy" with all
brokers up requires broker-side triage.

### 2. Look at broker-side errors

The Redpanda admin Prometheus endpoint
(`http://polaris-redpanda:9644/public_metrics`) exposes:

- `vectorized_kafka_rpc_errors_total` — RPC error rate by error class
- `vectorized_storage_disk_total_bytes` vs `vectorized_storage_disk_free_bytes`
- `vectorized_cluster_partition_under_replicated_replicas` — flags
  partitions that have lost a replica (ISR shrink)

In Grafana, the Redpanda exporter dashboard surfaces these as panels.
The placeholder `polaris-overview-placeholder` lists Redpanda
expected metrics; when the full Redpanda dashboard ships under
[`infra/grafana/dashboards/`](../../infra/grafana/dashboards/), link
it here.

### 3. Read the ingester's structured logs

```logql
{polaris_service="ingester-api"}
  | json
  | event=~"kafka\\.publish\\.(error|retry|drop)"
  | environment="${ENVIRONMENT}"
```

The log payload identifies the offending topic, partition, broker
id, and the underlying error message. A spike against one broker id
points at a broker; a spike against one topic points at a topic
problem (retention, partition count, isolation cutover).

### 4. Sanity-check ingester configuration

```bash
docker compose exec ingester-api \
  printenv | grep -E '^POLARIS_(REDPANDA|KAFKA)'
```

Compare to the broker addresses returned by `rpk cluster info`. If
they disagree, the ingester needs a reload (or its
`POLARIS_REDPANDA_BROKERS` updated).

## Mitigations

### Short-term

- **Restart the failing broker.** If one broker is reporting hard
  errors and `rpk cluster health` agrees, restart it. Polaris ingest
  retries publishes with backoff so a brief broker absence is
  invisible to SDKs.
- **Shed load.** When the failure is broker-side throttling, the
  ingester-api can be scaled DOWN temporarily (or its rate-limit
  bumped down via control plane) so producers back off uniformly
  instead of compounding the throttle. The SDK retry contract
  accommodates short ingest unavailability.
- **Roll back recent ingester deploys** if the spike correlates with
  a deploy timestamp; a regression in the Kafka client wiring is a
  plausible cause.

### Long-term

- **Bump broker capacity.** Sustained quota throttling means the
  cluster is undersized for current traffic; provision more brokers
  or larger disks.
- **Tiered storage / retention.** If the failure is "disk full,"
  tune retention policy or enable tiered storage to offload older
  segments.
- **Land the publish-failure metric.** The ingester needs to emit
  `polaris_ingest_publish_failed_total` so this runbook stops
  relying on Redpanda-side proxies; tracked in
  [`docs/operations/alerts.md`](alerts.md).

## Escalation

Page the infrastructure rotation if:

- broker health does not recover within 15 minutes,
- the cluster reports `under_replicated_partitions > 0` for more than
  five minutes,
- disk capacity is below the 20% headroom threshold from
  [`docs/operations/backup-and-retention.md`](backup-and-retention.md).

Page the on-call data engineer if ingester-side logs show the
problem is publisher-side (config / wiring) rather than broker-side
and a configuration rollback is non-trivial.

## Cross-references

- [Processor Lag Runbook](runbook-processor-lag.md) — publish
  failures often surface downstream as consumer lag once the publish
  recovers and a backlog drains.
- [Alerts index](alerts.md) — every alert with its threshold and
  this runbook URL.
- [Backup and Retention](backup-and-retention.md) — disk-headroom
  posture and Redpanda retention defaults.
