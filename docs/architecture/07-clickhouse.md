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

## Replay and Rebuild

ClickHouse projection rebuilds are replay/rebuild workflows.

Rules:

- Do not manually patch projection tables as a normal fix path.
- Rebuilds should be represented as replay/rebuild jobs.
- Rebuild jobs should record source range, target tables, reason, requester, and outcome.
- `analytics_ingest_log` helps diagnose duplicate or repeated ingestion.
- `analytics_raw` should be the normal base for analytical projections.

