# ClickHouse Ingestion Lag Runbook

Operators use this runbook when ClickHouse's Kafka-engine ingestion
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
| `PolarisClickHouseIngestionLagWarn` | warn | ClickHouse Kafka ingestion lag >2 min |
| `PolarisClickHouseIngestionLagPage` | page | ClickHouse Kafka ingestion lag >10 min |
| `PolarisClickHouseMVFailure` | page | any materialized view in `failed` state |

**v1 metric gap.** Polaris does not yet ship a ClickHouse exporter,
so these rules are wired with the v1 thresholds but will not fire
until the exporter lands. Until then, operators discover lag and
MV-state issues by querying ClickHouse directly (see
"Investigation"). The gap is tracked in
[`docs/operations/alerts.md`](alerts.md).

When the exporter lands it scrapes:

- `system.kafka_consumers` → `polaris_clickhouse_kafka_ingestion_lag_seconds{table=...}`
- `system.materialized_views` → `polaris_clickhouse_mv_state{view=...,state=...}`

## Symptoms

- Analytical queries against `polaris.analytics_raw` (or its
  projection tables) return stale results compared to the last
  `polaris ingest` write the operator can confirm via ingester logs.
- The ClickHouse `system.kafka_consumers` table reports a Kafka
  consumer with growing lag for one of the Polaris analytics-events
  topics.
- A materialized view is missing rows that should exist by now (the
  projection-table-freshness signal).

## Probable causes, ranked

1. **ClickHouse server overloaded.** Inserts are queueing because the
   server is CPU- or merge-bound. `system.merges` shows many running
   merges; `MergeTree parts count` is high.
2. **Materialized view exception.** A MV that fans out from
   `analytics_raw` threw during processing of a recent batch. The
   Kafka consumer suspends until the MV is fixed or marked invalid.
3. **Disk full / disk-pressure.** ClickHouse refuses to insert when
   the data volume is approaching the configured threshold.
4. **Kafka consumer engine misconfigured.** A schema mismatch
   (envelope changed, MV expects an older column shape, etc.) causes
   per-message errors. `system.kafka_consumers.last_exception`
   carries the reason.
5. **Slow MV target table.** A downstream projection table is the
   bottleneck (e.g. `analytics_first_touch` rebuilding under load);
   inserts to `analytics_raw` succeed but the MV chain stalls.
6. **Broker-side consumer offset drift.** Rare; Kafka consumer-group
   offsets stuck because of a config change.

## Investigation

### 1. Check Kafka-engine consumer lag

```sql
SELECT
  database,
  table,
  consumer_id,
  assignments.partition_id AS partition,
  assignments.current_offset AS current_offset,
  exceptions.text AS last_exception,
  is_currently_used
FROM system.kafka_consumers
WHERE database = 'polaris'
ORDER BY current_offset ASC;
```

`last_exception` is the smoking gun for cause #2 / #4 — a MV failure
or a schema mismatch leaves the exception message there.

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
  step that unblocks the Kafka consumer without losing source data.
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

- Kafka ingestion lag exceeds 30 minutes,
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
