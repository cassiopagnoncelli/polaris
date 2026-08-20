# RabbitMQ Publish Failures Runbook

Operators use this runbook when the ingester-api or a processor's emitter
is failing to publish to RabbitMQ at a rate that breaches the default
threshold of 0.5% over one minute.

Binding architecture references:

- [RabbitMQ Streams](../architecture/03-rabbitmq-streams.md)
- [Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)

The ingester publisher lives at
[`apps/ingester-api/`](../../apps/ingester-api/). The shared transport
client lives at
[`libs/bus/`](../../libs/bus/). The
Prometheus rule that triggers this runbook lives at
[`infra/prometheus/rules/polaris.alerts.yml`](../../infra/prometheus/rules/polaris.alerts.yml).

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisRabbitmqPublishFailureRate` | page | publish failure share >0.5% over 1 minute |

**Metric gap.** The publish-failure counter
`polaris_ingest_publish_failed_total` does not exist yet. The alert is
wired with the threshold and will not fire until the ingester publisher
emits the counter; the gap is tracked in
[`docs/operations/alerts.md`](alerts.md). Until then, operators rely on
broker-side metrics and the ingester's structured logs.

## What "publish failed" means here

Polaris publishes on a **confirm channel with `mandatory: true`** and
awaits the broker ack. Three distinct things can fail, and they are worth
separating before triage:

1. **Nack** — the broker refused the message (resource alarm, queue in
   `reject-publish` overflow).
2. **Unroutable return** — the exchange exists but no binding matched, or
   the exchange does not exist. The publish is *dropped*, and Polaris
   turns the return into a failure so it cannot pass silently.
3. **Channel/connection error** — the broker went away mid-publish.

Kafka had no analogue of (2), because Redpanda created topics on demand.
On RabbitMQ it is the single most likely failure after a deploy or an
isolation cutover.

## Symptoms

- Ingester logs show `"publish returned as unroutable"` or
  `"producer channel error"` at elevated rates.
- `rabbitmq_channel_messages_unroutable_dropped_total` is non-zero on the
  **Polaris — RabbitMQ** dashboard. This is decisive: it means topology,
  not capacity.
- Producer-side latency on the ingest endpoint climbs while ingester CPU
  stays flat — the publish is the bottleneck.
- `polaris_ingest_batch_rejected_total{reason="publish_failed"}` rises.

## Probable causes, ranked

1. **Incomplete topology.** A stream family or binding was never
   declared — new environment, new family, or an isolation cutover whose
   dedicated super stream was not provisioned. Errors are unroutable
   returns, not nacks.
2. **Broker resource alarm.** RabbitMQ blocks publishers when free disk
   drops below `disk_free_limit` or memory exceeds
   `vm_memory_high_watermark`. Publishers hang rather than error;
   connections show as `blocked`.
3. **Quorum queue in reject-publish overflow.** A retry tier or DLQ hit
   its length limit. Only affects retry/DLQ publishes, not stream
   publishes.
4. **Broker unavailable.** Node down (rolling restart, node failure,
   network partition).
5. **Permission drift.** The service's user lost `write` on the vhost or
   on the exchange after a credential rotation.
6. **Publisher mis-configured.** Stale `POLARIS_RABBITMQ_URL` after a
   broker address or vhost change.

## Investigation

### 1. Confirm broker health and alarms

```bash
docker compose exec polaris-rabbitmq rabbitmq-diagnostics -q status
```

```bash
docker compose exec polaris-rabbitmq rabbitmq-diagnostics -q alarms
```

An alarm (`resource_limit_alarm`) means publishers are blocked — that is
cause (2), and the fix is disk or memory, not the publisher.

### 2. Rule topology in or out

The fastest check. Unroutable returns mean the exchange or binding is
missing:

```bash
docker compose exec polaris-rabbitmq rabbitmqctl list_exchanges name type
```

```bash
docker compose exec polaris-rabbitmq rabbitmqctl list_bindings source_name routing_key destination_name
```

Compare against the declared topology:

```bash
pnpm rabbitmq:provision:dry-run
```

If anything is missing, provisioning is idempotent and safe to re-run:

```bash
pnpm rabbitmq:provision
```

See [RabbitMQ Topology Runbook](runbook-rabbitmq-topology.md) if the run
fails with `PRECONDITION_FAILED` — that means an object exists with
*different* arguments, which is a migration, not a re-run.

### 3. Check blocked connections

```bash
docker compose exec polaris-rabbitmq rabbitmqctl list_connections name state user
```

A `blocked` or `blocking` state confirms a resource alarm.

### 4. Read the ingester's structured logs

```logql
{polaris_service="ingester-api"}
  | json
  | component="transport.producer"
  | environment="${ENVIRONMENT}"
```

The log payload identifies the exchange, routing key, and underlying
error. A spike against one exchange points at topology; a spike across
all of them points at the broker.

### 5. Sanity-check publisher configuration

```bash
docker compose exec ingester-api printenv | grep -E '^POLARIS_RABBITMQ'
```

Confirm the URL's host, vhost, and credentials match the running broker.
Confirm `POLARIS_RABBITMQ_PARTITIONS` and
`POLARIS_RABBITMQ_PARTITION_OVERRIDES` match every other service's — a
disagreement routes to partitions that may not be bound.

## Mitigations

### Short-term

- **Re-run provisioning.** For unroutable returns this is the fix. It is
  idempotent.
- **Clear the resource alarm.** Free disk (drop old stream segments,
  extend the volume) or restart the node under memory pressure. Publishers
  unblock automatically once the alarm clears.
- **Restart the failing node.** Polaris ingest retries publishes with
  backoff, so a brief broker absence is invisible to SDKs.
- **Shed load.** When the broker is resource-constrained, scale the
  ingester DOWN temporarily (or lower its rate limit) so producers back
  off uniformly. The SDK retry contract accommodates short ingest
  unavailability.
- **Roll back recent deploys** if the spike correlates with a deploy
  timestamp.

### Long-term

- **Size the cluster.** Sustained alarms mean the broker is undersized for
  current traffic; provision more memory or disk.
- **Tune retention.** If the failure is "disk full", lower
  `POLARIS_RABBITMQ_STREAM_RETENTION_DAYS` for new streams or shrink
  `x-max-length-bytes` (a topology migration — see the topology runbook).
- **Land the publish-failure metric.** The ingester needs to emit
  `polaris_ingest_publish_failed_total` so this runbook stops relying on
  proxies; tracked in [`docs/operations/alerts.md`](alerts.md).

## Escalation

Page the infrastructure rotation if:

- broker health does not recover within 15 minutes,
- a resource alarm persists for more than five minutes,
- disk capacity is below the 20% headroom threshold from
  [`docs/operations/backup-and-retention.md`](backup-and-retention.md).

Page the on-call data engineer if ingester-side logs show the problem is
publisher-side (config / topology) rather than broker-side and a
configuration rollback is non-trivial.

## Cross-references

- [RabbitMQ Topology Runbook](runbook-rabbitmq-topology.md) — declaring,
  changing, and diagnosing streams and queues.
- [Processor Lag Runbook](runbook-processor-lag.md) — publish failures
  often surface downstream as consumer lag once the publish recovers and a
  backlog drains.
- [Alerts index](alerts.md) — every alert with its threshold and this
  runbook URL.
- [Backup and Retention](backup-and-retention.md) — disk-headroom posture
  and stream retention defaults.
