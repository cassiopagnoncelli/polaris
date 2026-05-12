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
Redpanda analytics.events
    |
    v
polaris.analytics_events_queue          (Kafka Engine, never queried)
    |
    +--> MV ----> polaris.analytics_ingest_log   (MergeTree, append-only)
    |
    +--> MV ----> polaris.analytics_raw          (ReplacingMergeTree, deduped facts)
                       |
                       v
                  argMax MV ----> projection tables (query surface)
```

The Kafka Engine table is **never** queried directly. The two MVs
that read from it are the only sanctioned consumers. Application
queries hit projection tables. `analytics_raw` reads only happen
through the helper-package's `replay` namespace under the
`polaris_operator` role.

## File layout

```text
sql/clickhouse/
  00_database.sql                              CREATE DATABASE polaris
  10_analytics_events_queue.sql                Kafka Engine table
  20_analytics_ingest_log.sql                  append-only ingest log
  21_mv_queue_to_ingest_log.sql                MV: queue -> ingest log
  30_analytics_raw.sql                         ReplacingMergeTree raw facts
  31_mv_queue_to_raw.sql                       MV: queue -> raw (flatten JSON)
  projections/
    40_event_daily_counts.sql                  example SummingMergeTree projection
  materialized-views/
    41_mv_raw_to_event_daily_counts.sql        argMax-based MV
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
10-19   Kafka Engine ingestion tables
20-29   ingest log + its MV
30-39   analytics_raw + its MV
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

- Never `SELECT` from `polaris.analytics_events_queue`. Not from
  services, not from operators. Use the ingest log to diagnose
  ingestion.
- Never `SELECT` from `polaris.analytics_raw` without an explicit
  dedupe construct. The three sanctioned shapes are:
  - `argMax(col, _version)` inside an MV feeding a projection
    (the canonical pattern; do this by default)
  - `SETTINGS final = 1` for ad-hoc operator queries
  - `count(DISTINCT event_id)` for unique-event counts
- Read application data from projection tables, which already store
  deduped rows.
- `FINAL` as a keyword is reserved for the `operator.raw.query`
  escape hatch in `packages/shared-clickhouse/`. It must not appear
  in any MV, projection, or service-code SQL string.

## Roles

See [`roles/README.md`](./roles/README.md). The short version:

- `polaris_service`: SELECT on `analytics_ingest_log` and every
  projection table. No access to `analytics_raw` or the Kafka Engine
  table.
- `polaris_operator`: full read access to `polaris.*` plus
  schema/replay grants.

Services authenticate as `polaris_service`. Replay/rebuild jobs and
operator investigation use `polaris_operator`. Both go through
[`packages/shared-clickhouse/`](../../docs/implementation/tasks/P0-010-shared-clickhouse-client.md);
direct `@clickhouse/client` imports outside that package are blocked
by a workspace import rule.
