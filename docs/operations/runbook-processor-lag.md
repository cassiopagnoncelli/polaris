# Processor / Consumer Lag Runbook

Operators use this runbook when a processor or destination consumer
falls behind its source topic by more than the v1 default thresholds:
five minutes of lag (warn) or fifteen minutes (page).

Binding architecture references:

- [Processors and Replay](../architecture/05-processors-and-replay.md)
- [RabbitMQ Streams](../architecture/03-rabbitmq-streams.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)

The processor runtime emitting the lag metric lives at
[`packages/shared-processor/`](../../packages/shared-processor/). The
identity-resolver and analytics-projector processors that consume the
shared topics live at
[`processors/`](../../processors/). The Prometheus rules that trigger
this runbook live at
[`infra/prometheus/rules/polaris.alerts.yml`](../../infra/prometheus/rules/polaris.alerts.yml).

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisRabbitMQConsumerLagWarn` | warn | `polaris_processor_lag_ms_last > 300_000` for 5m (any pivot) |
| `PolarisRabbitMQConsumerLagPage` | page | `polaris_processor_lag_ms_last > 900_000` for 5m (any pivot) |

Pivots include `processor_name`, `processor_version`, `project_id`,
`environment`, `topic_family`, `concrete_topic`, `partition`. The
metric is emitted per partition by the shared processor runtime so
the alert fires on the first partition that lags, not the average.

## Symptoms

- The per-project consumer-lag dashboard
  (Grafana UID `polaris-per-project-lag`) shows a sustained lag on
  one project or one partition.
- Downstream consumers see stale analytics events; end-to-end (raw
  → analytics) latency exceeds the v1 SLO of p99 60 s (see
  [`docs/operations/slos.md`](slos.md)).
- Processor `polaris_processor_events_consumed_total` rate is lower
  than the upstream `polaris_ingest_batch_accepted_total` rate for
  the same project.

## Probable causes, ranked

1. **Recent deploy in catch-up.** The processor pod was restarted
   and is consuming through the backlog accumulated during the
   restart window. Self-healing; the lag dashboard shows a single
   downward slope.
2. **Slow downstream dependency.** The processor's external call is
   slow (vendor API, ClickHouse insert, secret-provider lookup) so
   per-message handler time climbed. The
   `polaris_processor_handler_duration_ms_last` gauge identifies
   which handler is slow.
3. **Under-scaled processor.** The processor's pod count or partition
   assignment is too small for current traffic. Lag rises linearly
   without an obvious downstream cause.
4. **Hot partition / skew.** One partition holds most of the keys
   (the volume-share skew trigger). Other partitions are healthy.
   See the per-partition skew dashboard (UID
   `polaris-per-partition-skew`).
5. **Poison message stuck.** A message that the handler keeps
   retrying without DLQ-ing is blocking partition progress. The
   processor's `polaris_processor_events_retry_total` rate climbs on
   the affected partition while `consumed_total` flatlines.
6. **The processor is disabled for that project.** Someone ran
   `polaris processors disable`, so the runtime acknowledges that
   project's events without acting on them. This looks like lag on
   the derived topic while the source topic drains normally — the
   telltale is
   `polaris_processor_events_skipped_total{reason="processor_disabled"}`
   climbing at the rate `consumed_total` would have. Confirm with
   `polaris processors list` or the admin panel's Processors page,
   and re-enable with `polaris processors enable` if the disable was
   not intended. Takes effect within ~10s; no redeploy.
7. **Topic isolation cutover in flight.** A `polaris topics isolate`
   was issued and the resolver cache is mid-cutover; producers may
   still be writing to the shared topic while the consumer cut over
   (or vice versa). See
   [`docs/operations/topic-isolation-cutover.md`](topic-isolation-cutover.md).

## Investigation

### 1. Identify the lagging pivot

Open Grafana, dashboard UID `polaris-per-project-lag`
([`per-project-consumer-lag.json`](../../infra/grafana/dashboards/per-project-consumer-lag.json)).
Set `topic_family` and `environment`; the time-series panel shows the
per-project lag. The stat panel surfaces the latest
per-processor pivot.

### 2. Check for catch-up after a deploy

Loki query for the affected processor:

```logql
{polaris_service="${PROCESSOR_NAME}"}
  | json
  | event=~"processor\\.(start|rebalance|catch_up)"
  | environment="${ENVIRONMENT}"
```

A start/rebalance event within the lag window means cause #1
(self-healing). Confirm by watching the lag panel — it should be
trending DOWN, not steady-state.

### 3. Find the slow handler

Prometheus query for handler duration:

```
max by (processor_name, processor_version) (
  polaris_processor_handler_duration_ms_last{environment="${ENVIRONMENT}"}
)
```

If the duration is high (e.g. >100 ms steady state) compared to the
processor's design target, the downstream call is the bottleneck.
Match the value to the processor's known per-message budget.

### 4. List processor runs for control-plane history

```bash
polaris processors runs --processor <processor_name> --limit 20
```

Surfaces recent control-plane invocations of the processor (replay
runs, manual triggers). A replay running in parallel with normal
traffic is a common over-subscription cause.

### 5. Check partition skew

Open Grafana, dashboard UID `polaris-per-partition-skew`
([`per-partition-skew.json`](../../infra/grafana/dashboards/per-partition-skew.json)).
If one partition is carrying most of one project's traffic, the
isolation trigger from
[`docs/architecture/03-rabbitmq-streams.md`](../architecture/03-rabbitmq-streams.md)
applies; cross-reference
[`topic-isolation-cutover.md`](topic-isolation-cutover.md).

### 6. Look for poison messages

```logql
{polaris_service="${PROCESSOR_NAME}"}
  | json
  | event="processor.message.retry"
  | environment="${ENVIRONMENT}"
  | project_id="${PROJECT_ID}"
```

A message that retries the same `event_id` repeatedly is poison.
Either the handler has a bug or the message itself is malformed in a
way the schema-validation gate at ingest didn't catch.

## Mitigations

### Short-term

- **Scale up the processor.** Increase the replica count AND
  redistribute `POLARIS_RABBITMQ_ASSIGNED_PARTITIONS` so the new
  replica owns a disjoint slice.

  **RabbitMQ has no rebalance.** Adding a replica without changing the
  assignment does nothing — the new pod reads the same partitions as
  the old one, or none at all. Confirm ownership afterwards:

  ```bash
  docker compose exec polaris-rabbitmq \
    rabbitmqctl list_queues name consumers | grep '^raw\.events-'
  ```

  A partition with `consumers = 0` is an unowned backlog. See
  [RabbitMQ Topology](runbook-rabbitmq-topology.md).
- **Slow the producer.** When the lag is destination-bound and the
  downstream API is the bottleneck, throttle the producer via the
  ingester's rate-limit knob (per-key, per-project). The SDK retries
  back-pressure-aware.
- **Check whether the transport already skipped it.** A message that
  fails 5 times in a row at the same offset is published to
  `<component>.dlq` and skipped automatically, with a
  `consumer.poisoned` hook and an error log naming the offset. If lag
  recovered on its own, look there first — the event is in the DLQ, not
  lost, and `polaris dlq list` will show it.

- **Skip the poison message** by DLQ-ing it manually (operator
  judgment). Use the processor's DLQ surface (`polaris dlq retry` for
  destination DLQ; processor-side DLQ surfaces ship per processor —
  consult the processor's README).

### Long-term

- **Isolate the project.** When skew or schema-risk persists across
  review cycles, follow
  [`topic-isolation-cutover.md`](topic-isolation-cutover.md) to move
  the project to a dedicated topic.
- **Tune the handler.** If `handler_duration_ms_last` is the binding
  constraint, the long-term fix is a code change to the processor
  (batched downstream calls, cache, etc.).
- **Replan a replay window.** When the cause was an oversubscribed
  replay, narrow the replay window or run it during off-peak hours.

## Escalation

Page the infrastructure rotation if:

- lag exceeds 15 minutes on more than one processor simultaneously
  (suggests a RabbitMQ-side issue, not a processor issue),
- scaling the processor doesn't visibly drain the backlog within 10
  minutes,
- the lag dashboard correlates with `under_replicated_partitions > 0`
  on the broker.

Page the SDK rotation if catch-up indicates producer-side
back-pressure failures — SDKs should be retrying with backoff, not
hammering through the ingest endpoint.

## Cross-references

- [Topic Isolation Cutover](topic-isolation-cutover.md) — long-term
  fix for skew/schema-risk lag.
- [DLQ Growth Runbook](runbook-dlq-growth.md) — when the lag turns
  out to be DLQ-bound.
- [Alerts index](alerts.md) — every alert with its threshold and
  this runbook URL.
- [SLOs](slos.md) — the end-to-end latency SLO that lag breaks.
