# ClickHouse

## Role

ClickHouse is the analytical engine for Polaris.

It is part of the stream graph, not just an afterthought database.

The mature ingestion path is:

```text
Redpanda analytics.events
    |
    v
ClickHouse Kafka Engine table
    |
    v
analytics_ingest_log
    |
    v
analytics_raw
    |
    v
materialized views
    |
    v
projection tables
```

Kafka Engine tables are transient ingestion interfaces. They are not queried directly.

## Initial Format

Start with:

```text
JSONEachRow
```

Later evolution may use:

```text
Avro or Protobuf + Schema Registry
```

## Two-Layer Raw Storage

ClickHouse uses two persisted raw analytical layers.

### analytics_ingest_log

Append-only record of what ClickHouse consumed.

Purpose:

- preserve ingestion behavior
- debug duplicate delivery
- inspect malformed analytical stream rows if allowed by schema
- separate transport truth from analytical truth

### analytics_raw

Deduped analytical fact table keyed by stable event identity.

Purpose:

- cleaner base for analytics
- reduced overcount risk
- stable source for materialized views and projection tables

Expected stable keys include:

```text
project_id
environment
event_id
event
schema_version
```

## V1 Physical Defaults

These defaults are configurable, but they define the initial physical model.

### Kafka Engine Table

The Kafka Engine table is transient and must not be queried directly.

Example:

```text
analytics_events_queue
ENGINE = Kafka
FORMAT = JSONEachRow
```

### Append-Only Ingest Log

Use `MergeTree`.

Purpose:

- record what ClickHouse consumed
- preserve visibility into duplicates
- support ingestion debugging

Suggested physical shape:

```text
analytics_ingest_log
ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (project_id, environment, ingested_at, event_id)
TTL ingested_at + INTERVAL 30 DAY
```

### Deduped Analytical Raw Table

Use `ReplacingMergeTree`.

Purpose:

- provide cleaner analytical facts
- reduce accidental overcounting
- keep stable raw analytical base for projections

Suggested physical shape:

```text
analytics_raw
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, environment, event, event_id)
TTL occurred_at + INTERVAL 400 DAY
```

Expected columns include:

```text
event_id
event
schema_version
project_id
environment
occurred_at
ingested_at
source_id
source_type
anonymous_id
session_id
customer_id
properties_json
context_json
processor metadata
_version
```

`ReplacingMergeTree` deduplication is merge-time behavior. Queries and projections that require strict dedupe must be designed around stable event keys. Do not use `FINAL` broadly by default because it can be expensive. The query patterns below define how dedupe is handled in practice.

## Query Patterns

`ReplacingMergeTree` dedupe runs at merge time, not insert time and not query time. Between merges, duplicate rows are both in the table. The patterns below are how each query path handles that.

### Core rule

`analytics_raw` is never queried without explicit dedupe. Plain `SELECT *` on `analytics_raw` is wrong.

### Pattern 1: materialized views feeding projection tables

Materialized views are the primary readers of `analytics_raw`. They use `argMax(col, _version)` to mimic ReplacingMergeTree's per-key collapse, then write deduped rows into projection tables.

```sql
SELECT
  project_id, environment, event, event_id,
  argMax(properties_json, _version) AS properties_json,
  argMax(occurred_at, _version)     AS occurred_at,
  argMax(source_id, _version)       AS source_id,
  ...
FROM analytics_raw
GROUP BY project_id, environment, event, event_id
```

`argMax(col, _version)` returns the value of `col` from the row with the highest `_version` within the group. This is functionally equivalent to what ReplacingMergeTree's merge would have produced.

### Pattern 2: projection tables are the query surface

Projection tables store already-deduped rows. They are the query surface for dashboards and APIs. Reads against projection tables use plain `SELECT` — no `FINAL`, no `argMax`, no `GROUP BY` on identity keys.

Projection table engines are chosen per query shape:

```text
MergeTree              fact-shaped projections, append-only after dedupe
SummingMergeTree       pre-summed counters by group key
AggregatingMergeTree   pre-aggregated state functions for complex aggregates
```

The MV's `argMax` aggregation handles the dedupe so the projection table never sees duplicates from the same `event_id`.

### Pattern 3: ad-hoc operator queries

One-off operator queries on `analytics_raw` use `SETTINGS final = 1` rather than the `FINAL` keyword:

```sql
SELECT count() FROM analytics_raw
WHERE project_id = 'storefront' AND occurred_at >= now() - INTERVAL 1 DAY
SETTINGS final = 1;
```

`SETTINGS final = 1` is per-query, easy to switch off, and cluster-friendlier than the `FINAL` keyword. It is still expensive on hot partitions — use it for inspection, not for hot-path queries.

### Pattern 4: counting unique events

For event counts, prefer `count(DISTINCT event_id)` over `count()` plus dedupe. This sidesteps the merge-state question entirely:

```sql
SELECT count(DISTINCT event_id) FROM analytics_raw
WHERE project_id = 'storefront' AND occurred_at >= now() - INTERVAL 1 DAY;
```

### What is banned

- Plain `SELECT *` on `analytics_raw` without `argMax`, `SETTINGS final = 1`, or a `count(DISTINCT event_id)` shape.
- Production dashboards that use `FINAL` on hot data without an explicit review note.
- Querying `analytics_events_queue` (the Kafka Engine table) directly.

## Access Control

The query patterns above are policy. The actual enforcement is at the database level through ClickHouse roles and grants. The lint approach (regex over SQL strings) was considered and rejected — it false-positives on CTEs and dynamic SQL, false-negatives on aliased table references, and the escape-hatch comments decay over time.

### Roles

Two roles ship in v1:

```text
polaris_service     SELECT on projection tables and analytics_ingest_log only
polaris_operator    broader access including analytics_raw and DDL
```

Role definitions and grants live in `sql/clickhouse/roles/` and are applied as part of P1-003.

### Connection identity

- Services (ingester, processors, consumers, future dashboard API) authenticate as `polaris_service`. The connection literally cannot read `analytics_raw`.
- Operator workflows (CLI replay execution, manual investigation via `clickhouse-client`, rebuild jobs) authenticate as `polaris_operator`.
- The CLI splits its workload: routine read commands use the service role; replay/rebuild commands use the operator role.

### Shared client package

The `packages/shared-clickhouse/` workspace package is the only sanctioned in-process access path. It wraps the official `@clickhouse/client` package and exposes:

- service-profile read methods scoped to projection tables and the ingest log
- operator-profile methods including `argMax`-based reads against `analytics_raw` (`replay.argMaxByEventKey`, `replay.countDistinctEvents`)
- an operator-only `raw.query` escape hatch that emits a metric and structured log line on every call, so escape-hatch usage is observable

A workspace-level import rule prevents code outside `shared-clickhouse` from importing the official client directly. Services and CLI code use the helper; the helper enforces the dedupe pattern by construction. See [P0-010](../implementation/tasks/P0-010-shared-clickhouse-client.md).

### Ad-hoc operator SQL

Genuinely ad-hoc operator SQL — investigation, one-off counts, schema exploration — runs through `clickhouse-client` directly under the `polaris_operator` role. This is reviewed at use-time, not pre-committed; it leaves a trail in connection logs.

### Why grants instead of a lint

- The database refuses unauthorized reads. There is no "I forgot the comment" failure mode.
- New projection tables and MVs just need the right grant added; no lint to update.
- Dynamic SQL constructed in TS code is enforced the same way as static SQL — the connection role decides.
- The escape hatch is auditable because the helper emits a metric per call.

## Cluster Posture

The goal is a single migration path from dev to production scale. Engine families are picked once, at the start, to avoid rewriting tables when adding replicas.

### Engines

Production uses `Replicated*` engine families from day one, even on a single replica. Local/dev uses plain non-replicated engines because there is no ClickHouse Keeper to register with.

```text
local/dev      MergeTree, ReplacingMergeTree
production     ReplicatedMergeTree, ReplicatedReplacingMergeTree
```

DDL is parameterized through cluster macros so the same SQL file produces the right engine per environment:

```sql
CREATE TABLE analytics_raw ON CLUSTER '{cluster}' (
  ...
) ENGINE = {replicated}ReplacingMergeTree('/clickhouse/tables/{shard}/analytics_raw', '{replica}', _version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, environment, event, event_id);
```

The `{replicated}` macro expands to empty in local/dev and to `Replicated` in production.

### ClickHouse Keeper

Production runs **ClickHouse Keeper** alongside ClickHouse from day one. Keeper is the coordination service that `Replicated*` engines need. Embedded Keeper is acceptable for the first single-replica production deployment; external Keeper becomes necessary when multiple replicas land.

Local/dev does not run Keeper. Plain `MergeTree` engines do not require it.

### Materialized views

Materialized views are local-by-default. Cluster-aware MVs (created `ON CLUSTER`) are an explicit upgrade when multi-replica behavior is needed. The default keeps MV creation simple in local/dev and consistent in single-replica production.

### Distributed tables and sharding

`Distributed` tables and shard awareness are **not v1**. Single-shard, single-replica is the v1 production shape. Scaling from 1 replica to N replicas is straightforward with the `Replicated*` engines already in place. Scaling from 1 shard to N shards is a real migration and is honest future work, not a backwards-compatible engine swap.

### Local development

Single-node ClickHouse without Keeper is acceptable for local development and the first vertical slice. The SQL files must work in both modes through the `{replicated}` macro.

## Projection Tables

Projection tables are denormalized OLAP tables for dashboards and APIs.

Examples:

```text
merchant_daily_metrics
funnel_metrics
attribution_metrics
psp_routing_metrics
consumer_delivery_metrics
```

Materialized views transform inserts from raw analytical tables into projection tables. They are continuous incremental transformations, not ad hoc query views.

### Engine selection methodology

Projection tables pick the right ClickHouse engine for their query shape. There is no global default — each projection's PR includes the engine choice with rationale in the SQL file comment.

Default guidance:

```text
MergeTree              fact-shaped projections (denormalized rows, append-after-dedupe)
SummingMergeTree       pre-summed counters keyed by a group key
AggregatingMergeTree   complex aggregate states (uniq, quantile, custom states)
ReplacingMergeTree     projections that need their own dedupe layer (rare; analytics_raw upstream usually handles it)
```

In production these become `ReplicatedMergeTree`, `ReplicatedSummingMergeTree`, etc., via the `{replicated}` macro.

Rules:

- The PR introducing a projection table documents the engine choice and the query patterns it serves.
- Changing a projection's engine after it ships is a rebuild operation (P7-005), not a migration.
- Ad-hoc operator queries against projection tables use plain `SELECT`; the MV has already deduped.

## Replay and Rebuild

ClickHouse projection rebuilds are replay/rebuild workflows.

Rules:

- Do not manually patch projection tables as a normal fix path.
- Rebuilds should be represented as replay/rebuild jobs.
- Rebuild jobs should record source range, target tables, reason, requester, and outcome.
- `analytics_ingest_log` helps diagnose duplicate or repeated ingestion.
- `analytics_raw` should be the normal base for analytical projections.
