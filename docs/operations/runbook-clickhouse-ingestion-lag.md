# ClickHouse Ingestion Lag Runbook

Operators use this runbook when ClickHouse ingestion
falls behind the analytics events topic, or when a materialized view
falls into a failed state.

Binding architecture references:

- [ClickHouse](../architecture/07-clickhouse.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)
- [Production Readiness](../architecture/11-production-readiness.md)

The ClickHouse client shared package lives at
[`packages/shared-clickhouse/`](../../packages/shared-clickhouse/).
The schema for `polaris.analytics_ingest_log` and the projection
tables is documented at
[`docs/architecture/07-clickhouse.md`](../architecture/07-clickhouse.md).
The Prometheus rules that trigger this runbook live at
[`infra/prometheus/rules/polaris.alerts.yml`](../../infra/prometheus/rules/polaris.alerts.yml).

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisClickHouseIngestionLagWarn` | warn | ClickHouse ingestion lag >2 min |
| `PolarisClickHouseIngestionLagPage` | page | ClickHouse ingestion lag >10 min |
| `PolarisClickHouseSinkRowsSkipped` | warn | sink skipping >1 message/min for 10 min |
| `PolarisClickHouseMVFailure` | page | any materialized view in `failed` state |

**Read the `table` label first.** The sink feeds two ingestion interface
tables and every one of its series is labelled by which:

| `table` | Source | Lands in |
|---|---|---|
| `analytics_events_queue` | `resolved.events` | `analytics_ingest_log` + `analytics_raw` |
| `analytics_processed_queue` | `session` / `identity` / `attribution` `.events` | `analytics_processed` |
| `profile_events_queue` | `profile.events` | `profiles` |

Lag on one and not the other narrows the cause immediately: a shared
process, connection and batch timer means an isolated lag is upstream —
that family's processor — not the sink. Lag on both is the sink, the
connection, or ClickHouse itself.

**Where the lag signal comes from.** `async/warehouse/clickhouse-sink`
emits `polaris_clickhouse_sink_lag_seconds{table}` — now minus the
envelope's `ingested_at` for the last row it wrote. This replaced
`polaris_clickhouse_kafka_ingestion_lag_seconds`, which the retired
analytics-projector derived from `system.kafka_consumers`. That system
table is permanently empty since the RabbitMQ migration (ClickHouse
consumes nothing), so the old gauge would have reported a confident
zero forever — a lag alert that silently stops firing is worse than
one that fails loudly.

Materialized-view failures surface as INSERT failures, not as a state:
`polaris_clickhouse_sink_insert_failures_total{table}`. Polaris's MVs are
plain insert-triggered views and `materialized_views_ignore_errors` is 0,
so an MV whose SELECT throws fails the INSERT into its source table and
the exception reaches the sink. The `polaris_clickhouse_mv_state` gauge
this runbook used to name polled `system.view_refreshes`, which tracks
refreshable MVs only — it never carried a value, and the alert on it could
never fire. Both were removed in 126EPNIQ.

## Symptoms

- Analytical queries against `polaris.analytics_raw` (or its
  projection tables) return stale results compared to the last
  `polaris ingest` write the operator can confirm via ingester logs.
- `polaris_clickhouse_sink_lag_seconds` is climbing, or the sink's
  `polaris_clickhouse_sink_batches_total` has stopped advancing while
  `resolved.events` is still receiving traffic.
- A materialized view is missing rows that should exist by now (the
  projection-table-freshness signal).

## Probable causes, ranked

1. **ClickHouse server overloaded.** Inserts are queueing because the
   server is CPU- or merge-bound. `system.merges` shows many running
   merges; `MergeTree parts count` is high.
2. **Materialized view exception.** A MV that fans out from
   `analytics_raw` threw during processing of a recent batch. The
   INSERT fails, so the sink does not advance its checkpoint and
   retries the same batch until the MV is fixed.
3. **Disk full / disk-pressure.** ClickHouse refuses to insert when
   the data volume is approaching the configured threshold.
4. **Schema mismatch.** The envelope changed, or a MV expects an
   older column shape, so every INSERT fails. The sink's logs carry
   the ClickHouse error verbatim, and the batch repeats — a flat
   checkpoint with a rising error rate is the signature.
5. **Slow MV target table.** A downstream projection table is the
   bottleneck (e.g. `analytics_first_touch` rebuilding under load);
   inserts to `analytics_raw` succeed but the MV chain stalls.
6. **The sink is not running, or owns no partitions.** With static
   partition assignment nothing rebalances: a sink replica that is
   down, or a partition no replica is assigned, backs up silently.
   Check `rabbitmqctl list_queues name consumers` for
   `resolved.events-*` with `consumers = 0`.

## Investigation

### 1. Check the sink's position and its errors

The sink's checkpoint is the authoritative "how far has ClickHouse
ingestion got" signal:

```sql
-- PostgreSQL, not ClickHouse
SELECT stream, last_offset, updated_at
FROM transport_checkpoints
WHERE group_name = 'polaris-clickhouse-sink-v1'
ORDER BY stream;
```

A stale `updated_at` while `resolved.events` is receiving traffic
means the sink is stuck rather than idle. Its logs carry the reason:

```logql
{polaris_service="clickhouse-sink"} | json | component=~"clickhouse-sink.*"
```

A repeating ClickHouse error with a flat checkpoint is the smoking gun
for cause #2 / #4 — an MV failure or a schema mismatch.

The checkpoint query returns one row per partition stream across every
subscribed family, so it also shows which side is stuck. Streams named
`resolved.events-*` are the source path; `session.events-*`,
`identity.events-*` and `attribution.events-*` are the derived path; and
`profile.events-*` is the profile plane.

### 1b. Triage `PolarisClickHouseSinkRowsSkipped`

This alert is not about lag. A skipped message is one the sink could not
project onto an ingestion row — an undecodable body, or an envelope
missing one of `event_id`, `event`, `project_id`, `environment`,
`occurred_at`, `ingested_at`. The sink logs it, counts it, and advances
past it.

Advancing is deliberate: throwing would rewind the partition and
redeliver the same broken message forever, stalling every healthy event
behind it. But it does mean this is the **only** path where an event
leaves the pipeline without landing in ClickHouse, a DLQ, or an ingester
rejection — which is why a sustained rate is worth a page-adjacent look.

Find the offending messages:

```logql
{polaris_service="clickhouse-sink"} | json | component="clickhouse-sink.decode"
```

Each line carries `stream` and `offset`. Two causes, in likelihood
order:

1. **A processor started emitting a malformed envelope.** Check which
   family the `stream` belongs to and look at that processor's recent
   deploy. This is the common case and it is a code bug, not an
   operational one.
2. **Something is publishing to a canonical stream that should not be.**
   The families the sink reads are written only by Polaris processors;
   anything else on them is a misconfigured producer or a stray replay.

A steady non-zero rate with no recent deploy is worth escalating —
per the sink's contract the projector emits canonical envelopes, so a
non-zero rate means an assumption upstream has broken.

### 2. Check materialized-view state

```sql
SELECT
  database,
  name,
  status,
  last_refresh_result,
  last_exception
FROM system.view_refreshes
WHERE database = 'polaris'
  AND status != 'OK';
```

(On older ClickHouse versions without `system.view_refreshes`, query
`system.errors` for view-related error counts.)

Anything other than empty / `OK` is a failed MV; the exception text
identifies the root cause.

### 3. Inspect merges / parts count

```sql
SELECT
  database,
  table,
  count() AS parts,
  sum(bytes_on_disk) AS bytes
FROM system.parts
WHERE database = 'polaris'
  AND active = 1
GROUP BY database, table
ORDER BY parts DESC
LIMIT 10;
```

Parts count above ~1000 per table is a smell; ClickHouse's
default-merge-tree settings target ~150 active parts per partition.

```sql
SELECT count() FROM system.merges;
```

Many concurrent merges indicate cause #1 (overload). Look at
`is_mutation`, `progress`, and `total_size_bytes_compressed` for
hints on duration.

### 4. Check disk free

```sql
SELECT
  name,
  formatReadableSize(free_space) AS free,
  formatReadableSize(total_space) AS total
FROM system.disks;
```

Free space below the 20% headroom threshold from
[`docs/operations/backup-and-retention.md`](backup-and-retention.md)
is cause #3.

### 5. Check structured logs from polaris services

```logql
{polaris_service=~"polaris-.*"}
  | json
  | event=~"clickhouse\\.(insert|query)\\.(error|slow)"
  | environment="${ENVIRONMENT}"
```

The shared ClickHouse client logs slow queries and insert errors
with the query digest from `polaris_clickhouse_operator_raw_query_total`
(see [`packages/shared-clickhouse/src/raw.ts`](../../packages/shared-clickhouse/src/raw.ts)).

## Mitigations

### Short-term

- **Detach the broken materialized view (cause #2):** the surgical
  step that unblocks the sink without losing source data.
  ```sql
  DETACH TABLE polaris.<failing_mv>;
  ```
  Source data continues landing in `analytics_raw`; the MV is dark
  while you debug. Re-attach when fixed.
- **Increase ClickHouse server resources (cause #1):** scale
  vertically (CPU, RAM) or shard the table.
- **Free disk space (cause #3):** drop older partitions per
  retention policy (see
  [`docs/operations/backup-and-retention.md`](backup-and-retention.md)),
  or attach more disk.

### Long-term

- **Ship the polaris-clickhouse-exporter** so this runbook stops
  relying on manual `system.*` queries; tracked in
  [`docs/operations/alerts.md`](alerts.md).
- **Tune merge tree settings** for tables with persistent parts-count
  pressure.
- **Add MV idempotency tests** so a MV regression that breaks
  ingestion is caught in CI, not in production.

## Escalation

Page the on-call data engineer if:

- ClickHouse ingestion lag exceeds 30 minutes,
- multiple materialized views are simultaneously failed,
- disk free is below 10%.

Page the infrastructure rotation if ClickHouse server is
unreachable or CPU-saturated and vertical scaling is needed.

## Cross-references

- [Backup and Retention](backup-and-retention.md) — disk-headroom
  posture and retention defaults.
- [Alerts index](alerts.md) — every alert with its threshold and
  this runbook URL.
- [SLOs](slos.md) — the end-to-end latency SLO that ClickHouse
  ingestion lag breaks.
