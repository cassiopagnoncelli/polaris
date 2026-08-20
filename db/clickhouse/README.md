# Polaris ClickHouse SQL

SQL-first DDL for the Polaris analytical store. Same files apply in
local/dev (single node, plain engines, no Keeper) and in production
(Replicated\* engines + Keeper) via ClickHouse server macros.

See [`docs/architecture/07-clickhouse.md`](../../docs/architecture/07-clickhouse.md)
for the architecture rationale and
[`infra/clickhouse/`](../../infra/clickhouse/) for the macro
configuration that drives environment selection.

## Pipeline

```text
RabbitMQ analytics.events                RabbitMQ enriched / session /
    |                                     identity / attribution .events
    v                                            |
polaris.analytics_events_queue                   v
    (Null engine, never queried)      polaris.analytics_processed_queue
    |                                     (Null engine, never queried)
    |                                          |    |
    +--> MV --+--> polaris.analytics_ingest_log <---+
    |         |      (MergeTree, append-only, BOTH paths)
    |
    +--> MV --> polaris.analytics_raw          +--> MV --> polaris.analytics_processed
                  (ReplacingMergeTree,                       (ReplacingMergeTree,
                   deduped source facts)                      deduped derived facts)
                       |                                          |
                       v                                          v
                  argMax MV ----> projection tables (query surface)
```

Two ingestion interface tables, split by what the event *is*:
`analytics_events_queue` takes source events (what a producer reported),
`analytics_processed_queue` takes derived events (what a Polaris
processor concluded). `clickhouse-sink` picks the destination by stream
family at INSERT time, so every MV below stays unfiltered — see the
rationale on `11_analytics_processed_queue.sql`.

`analytics_ingest_log` takes rows from BOTH queues. It records what
ClickHouse consumed, and logging only half of what the sink writes would
leave duplicate-delivery forensics unanswerable for the derived families
— duplicates collapse in `analytics_processed` and take their lineage
with them.

Neither interface table is **ever** queried directly. The MVs that read
from them are the only sanctioned consumers. Application queries hit
projection tables. `analytics_raw` and `analytics_processed` reads only
happen through the helper-package's `replay` namespace under the
`polaris_operator` role.

## File layout

```text
db/clickhouse/
  00_database.sql                              CREATE DATABASE polaris
  10_analytics_events_queue.sql                ingestion interface, source events
  11_analytics_processed_queue.sql             ingestion interface, derived events
  20_analytics_ingest_log.sql                  append-only ingest log (both paths)
  21_mv_queue_to_ingest_log.sql                MV: source queue -> ingest log
  22_mv_processed_queue_to_ingest_log.sql      MV: derived queue -> ingest log
  30_analytics_raw.sql                         ReplacingMergeTree source facts
  31_mv_queue_to_raw.sql                       MV: queue -> raw (flatten JSON)
  32_analytics_processed.sql                   ReplacingMergeTree derived facts
  33_mv_processed_queue_to_processed.sql       MV: processed queue -> processed
  projections/
    40_event_daily_counts.sql                  SummingMergeTree projection over analytics_raw
    42_session_daily_metrics.sql               SummingMergeTree projection over analytics_processed
  materialized-views/
    41_mv_raw_to_event_daily_counts.sql        argMax-based MV
    43_mv_processed_to_session_daily_metrics.sql  argMax-based MV
  roles/
    00_roles.sql                               role definitions
    01_grants.sql                              role grants
    README.md                                  role model doc
  README.md                                    this file
```

Filenames are lexically ordered by intended apply order. The
ClickHouse client/migration runner in both environments applies them
top-down. New objects slot into the appropriate ranges:

```text
00-09   database / cluster bootstrap
10-19   ingestion interface tables
20-29   ingest log + its MVs (one per ingestion path)
30-39   raw-tier fact tables (analytics_raw, analytics_processed) + their MVs
40-89   projection tables and their argMax MVs
roles/  role definitions and grants (re-applied last)
```

## Engine families and macros

DDL uses three ClickHouse server macros:

| Macro | Local/dev | Production |
| --- | --- | --- |
| `{cluster}` | empty | single-shard cluster name (e.g. `polaris`) |
| `{replicated}` | empty | `Replicated` |
| `{shard}` / `{replica}` | empty / per-host | per-shard / per-replica |

Same SQL, same line numbers, different engine emitted at parse time.
Production additionally relies on ClickHouse server-level
`default_replica_path` and `default_replica_name` so the engine
specs need only the version column (no explicit ZK path argument).

The macro files live at
[`infra/clickhouse/config.d/`](../../infra/clickhouse/config.d/).

## Query rules (enforced by roles)

- Never `SELECT` from `polaris.analytics_events_queue` or
  `polaris.analytics_processed_queue`. Not from services, not from
  operators. Use the ingest log to diagnose ingestion.
- Never `SELECT` from `polaris.analytics_raw` or
  `polaris.analytics_processed` without an explicit dedupe construct.
  Both are ReplacingMergeTree; the three sanctioned shapes are:
  - `argMax(col, _version)` inside an MV feeding a projection
    (the canonical pattern; do this by default)
  - `SETTINGS final = 1` for ad-hoc operator queries
  - `count(DISTINCT event_id)` for unique-event counts
- Read application data from projection tables, which already store
  deduped rows.
- `FINAL` as a keyword is reserved for the `operator.raw.query`
  escape hatch in `libs/persistence/clickhouse/`. It must not appear
  in any MV, projection, or service-code SQL string.

## Roles

See [`roles/README.md`](./roles/README.md). The short version:

- `polaris_service`: SELECT on `analytics_ingest_log` and every
  projection table. No access to the raw-tier tables (`analytics_raw`,
  `analytics_processed`) or to either ingestion interface table.
- `polaris_operator`: full read access to `polaris.*` plus
  schema/replay grants.

Services authenticate as `polaris_service`. Replay/rebuild jobs and
operator investigation use `polaris_operator`. Both go through
[`libs/persistence/clickhouse/`](../../docs/implementation/tasks/P0-010-shared-clickhouse-client.md);
direct `@clickhouse/client` imports outside that package are blocked
by a workspace import rule.
