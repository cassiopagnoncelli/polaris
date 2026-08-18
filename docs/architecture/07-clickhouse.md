# ClickHouse

## Role

ClickHouse is the analytical engine for Polaris.

It is part of the stream graph, not just an afterthought database.

The mature ingestion path is:

``text
RabbitMQ resolved.events           RabbitMQ session /
    |                               identity / attribution .events
    v                                          |
ingestion interface table                      v
    |                              ingestion interface table
    +--> analytics_ingest_log                  |
    |                                          v
    +--> analytics_raw                 analytics_processed
             |
             v
      materialized views
             |
             v
      projection tables
``

The ingestion interface tables are transient. They are not queried directly.

## Two Kinds of Fact

Polaris streams carry two kinds of fact, and conflating them makes
`count()` meaningless:

- **Source events** are what a producer reported. They arrive on
  `resolved.events` and land in `analytics_raw`.
- **Derived events** are what a Polaris processor concluded —
  `enriched.geoip`, `session.started`, `identity.linked`,
  `touchpoint_captured`. They arrive on the four derived families and
  land in `analytics_processed`.

Both are full canonical envelopes; a derived event carries the emitting
processor in `source.id` and its own payload schema in `properties`.
Processors fan out from `raw.events` rather than chaining, so there is no
"enriched copy" of a source event — the two are siblings, and one page
view that triggers a geoip lookup and a session start is one row in
`analytics_raw` and two in `analytics_processed`, not three of anything.

`clickhouse-sink` routes by stream family at INSERT time rather than
filtering in the materialized views. A `WHERE` in each MV would have to
be right in three places and fails silently when it is not: a derived
event reaching `analytics_raw` inflates every projection built on it and
nothing in the system says so. Picking the destination table instead
makes a routing bug visible as rows in the wrong place.

Both paths write to the same `analytics_ingest_log`. That table records
what ClickHouse consumed, and consuming half the streams while logging
only the other half would make its name a lie — and would leave
duplicate-delivery forensics unanswerable for four of the five families
the sink reads, because duplicates collapse in `analytics_processed`'s
ReplacingMergeTree and take their lineage with them. The lineage columns
(`_topic`, `_partition`, `_offset`) also ride on `analytics_processed`
itself, so a single deduped row says which offset produced it; the log is
what says how many times it arrived.

## Initial Format

Start with:

``text
JSONEachRow
``

Later evolution may use:

``text
Avro or Protobuf + Schema Registry
``

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

``text
project_id
environment
event_id
event
schema_version
``

## V1 Physical Defaults

These defaults are configurable, but they define the initial physical model.

### Ingestion Interface Table

The ingestion interface table is transient and must not be queried
directly. It is a `Null` engine: rows are dropped on write and reach
only the materialized views.

``text
analytics_events_queue
ENGINE = Null
``

`async/warehouse/clickhouse-sink` INSERTs batches into it as `JSONEachRow`,
stamping the transport lineage columns (`_topic`, `_partition`,
`_offset`) that used to be Kafka Engine virtual columns.

**Why ClickHouse no longer consumes for itself.** Until the RabbitMQ
migration this table was `ENGINE = Kafka` and ClickHouse held its own
consumer group. RabbitMQ streams have no ClickHouse engine, and the AMQP
`RabbitMQ` engine that does exist has no offset concept — so no
offset-based recovery after a restart, and no lineage columns. Polaris
owns the delivery instead, which also means ingestion lag is a Polaris
metric (`polaris_clickhouse_sink_lag_seconds`) rather than a
ClickHouse-internal one.

### Append-Only Ingest Log

Use `MergeTree`.

Purpose:

- record what ClickHouse consumed
- preserve visibility into duplicates
- support ingestion debugging

Suggested physical shape:

``text
analytics_ingest_log
ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (project_id, environment, ingested_at, event_id)
TTL ingested_at + INTERVAL 30 DAY
``

### Deduped Analytical Raw Table

Use `ReplacingMergeTree`.

Purpose:

- provide cleaner analytical facts
- reduce accidental overcounting
- keep stable raw analytical base for projections

Suggested physical shape:

``text
analytics_raw
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, environment, event, event_id)
TTL occurred_at + INTERVAL 400 DAY
``

Expected columns include:

``text
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
``

### Deduped Derived-Fact Table

One table for all four derived families, not four tables: they share the
canonical envelope, they are queried together far more often than
separately, and `event` is already in the sort key.

``text
analytics_processed
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, environment, event, event_id)
TTL occurred_at + INTERVAL 400 DAY
``

Same sort key and TTL as `analytics_raw`, so the query patterns below
apply verbatim and joins between the two never outlive one side. It
carries `source_id` / `source_type` (which processor concluded the fact),
the identity block (the join keys back to `analytics_raw`),
`properties_json` (the derived payload), and the transport lineage
columns.

`ip`, `user_agent` and `locale` are deliberately **not** flattened here.
Processors strip the source IP when they emit — the geoip enricher
forwards a SHA-256 hash and an empty context precisely so raw IP lives on
exactly one record — and a structurally-always-empty `ip` column would
read as "no IPs observed" rather than "IPs are not on this table".

`ReplacingMergeTree` deduplication is merge-time behavior. Queries and projections that require strict dedupe must be designed around stable event keys. Do not use `FINAL` broadly by default because it can be expensive. The query patterns below define how dedupe is handled in practice.

"Stable event keys" is a requirement on the writer, not a property the engine
supplies. Derived facts satisfy it because processors mint `event_id` as a
UUIDv5 over `(processor_name, source_event_id, emission slot)` — see
[`derived-id.ts`](../../packages/shared-processor/src/derived-id.ts) — so a
redelivery reproduces the id and collapses. Rows written before that was true
carry a random UUIDv7 per attempt and never collapse; normalising them is
[Derived ID Normalisation](../operations/runbook-derived-id-normalisation.md).

## Query Patterns

`ReplacingMergeTree` dedupe runs at merge time, not insert time and not query time. Between merges, duplicate rows are both in the table. The patterns below are how each query path handles that.

### Core rule

`analytics_raw` is never queried without explicit dedupe. Plain `SELECT *` on `analytics_raw` is wrong.

### Pattern 1: materialized views feeding projection tables

Materialized views are the primary readers of `analytics_raw`. They use `argMax(col, _version)` to mimic ReplacingMergeTree's per-key collapse, then write deduped rows into projection tables.

``sql
SELECT
  project_id, environment, event, event_id,
  argMax(properties_json, _version) AS properties_json,
  argMax(occurred_at, _version)     AS occurred_at,
  argMax(source_id, _version)       AS source_id,
  ...
FROM analytics_raw
GROUP BY project_id, environment, event, event_id
``

`argMax(col, _version)` returns the value of `col` from the row with the highest `_version` within the group. This is functionally equivalent to what ReplacingMergeTree's merge would have produced.

### Pattern 2: projection tables are the query surface

Projection tables store already-deduped rows. They are the query surface for dashboards and APIs. Reads against projection tables use plain `SELECT` — no `FINAL`, no `argMax`, no `GROUP BY` on identity keys.

Projection table engines are chosen per query shape:

``text
MergeTree              fact-shaped projections, append-only after dedupe
SummingMergeTree       pre-summed counters by group key
AggregatingMergeTree   pre-aggregated state functions for complex aggregates
``

The MV's `argMax` aggregation handles the dedupe so the projection table never sees duplicates from the same `event_id`.

### Pattern 3: ad-hoc operator queries

One-off operator queries on `analytics_raw` use `SETTINGS final = 1` rather than the `FINAL` keyword:

``sql
SELECT count() FROM analytics_raw
WHERE project_id = 'storefront' AND occurred_at >= now() - INTERVAL 1 DAY
SETTINGS final = 1;
``

`SETTINGS final = 1` is per-query, easy to switch off, and cluster-friendlier than the `FINAL` keyword. It is still expensive on hot partitions — use it for inspection, not for hot-path queries.

### Pattern 4: counting unique events

For event counts, prefer `count(DISTINCT event_id)` over `count()` plus dedupe. This sidesteps the merge-state question entirely:

``sql
SELECT count(DISTINCT event_id) FROM analytics_raw
WHERE project_id = 'storefront' AND occurred_at >= now() - INTERVAL 1 DAY;
``

### What is banned

- Plain `SELECT *` on `analytics_raw` or `analytics_processed` without `argMax`, `SETTINGS final = 1`, or a `count(DISTINCT event_id)` shape.
- Production dashboards that use `FINAL` on hot data without an explicit review note.
- Querying either ingestion interface table (`analytics_events_queue`, `analytics_processed_queue`) directly.

## Access Control

The query patterns above are policy. The actual enforcement is at the database level through ClickHouse roles and grants. The lint approach (regex over SQL strings) was considered and rejected — it false-positives on CTEs and dynamic SQL, false-negatives on aliased table references, and the escape-hatch comments decay over time.

### Roles

Three roles ship in v1:

``text
polaris_service     SELECT on projection tables and analytics_ingest_log only
polaris_operator    broader access including the raw-tier tables and DDL
polaris_sink        INSERT on the two ingestion interface tables, SELECT on nothing
``

Role definitions and grants live in `sql/clickhouse/roles/` and are applied as part of P1-003.

### Connection identity

- Services (ingester, processors, consumers, future dashboard API) authenticate as `polaris_service`. The connection literally cannot read `analytics_raw` or `analytics_processed`.
- `clickhouse-sink` authenticates as `polaris_sink`, which holds INSERT on the two interface tables and no SELECT anywhere — the correct blast radius for a process whose whole job is moving bytes in one direction.
- Operator workflows (CLI replay execution, manual investigation via `clickhouse-client`, rebuild jobs) authenticate as `polaris_operator`.
- The CLI splits its workload: routine read commands use the service role; replay/rebuild commands use the operator role.

### Shared client package

The `packages/shared-clickhouse/` workspace package is the only sanctioned in-process access path. It wraps the official `@clickhouse/client` package and exposes:

- service-profile read methods scoped to projection tables and the ingest log
- operator-profile methods including `argMax`-based reads against both raw-tier tables — `replay.argMaxByEventKey` / `replay.countDistinctEvents` for `analytics_raw`, and `replay.argMaxProcessedByEventKey` / `replay.countDistinctProcessedEvents` for `analytics_processed`. One set of builders serves both, parameterised by table and column list, so the dedupe pattern cannot drift between them.
- an operator-only `raw.query` escape hatch that emits a metric and structured log line on every call, so escape-hatch usage is observable

A workspace-level import rule prevents code outside `shared-clickhouse` from importing the official client directly. Services and CLI code use the helper; the helper enforces the dedupe pattern by construction. See `P0-010`.

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

``text
local/dev      MergeTree, ReplacingMergeTree
production     ReplicatedMergeTree, ReplicatedReplacingMergeTree
``

DDL is parameterized through cluster macros so the same SQL file produces the right engine per environment:

``sql
CREATE TABLE analytics_raw ON CLUSTER '{cluster}' (
  ...
) ENGINE = {replicated}ReplacingMergeTree('/clickhouse/tables/{shard}/analytics_raw', '{replica}', _version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, environment, event, event_id);
``

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

``text
merchant_daily_metrics
funnel_metrics
attribution_metrics
psp_routing_metrics
consumer_delivery_metrics
``

Materialized views transform inserts from raw analytical tables into projection tables. They are continuous incremental transformations, not ad hoc query views.

### Engine selection methodology

Projection tables pick the right ClickHouse engine for their query shape. There is no global default — each projection's PR includes the engine choice with rationale in the SQL file comment.

Default guidance:

``text
MergeTree              fact-shaped projections (denormalized rows, append-after-dedupe)
SummingMergeTree       pre-summed counters keyed by a group key
AggregatingMergeTree   complex aggregate states (uniq, quantile, custom states)
ReplacingMergeTree     projections that need their own dedupe layer (rare; analytics_raw upstream usually handles it)
``

In production these become `ReplicatedMergeTree`, `ReplicatedSummingMergeTree`, etc., via the `{replicated}` macro.

Rules:

- The PR introducing a projection table documents the engine choice and the query patterns it serves.
- Changing a projection's engine after it ships is a rebuild operation (P7-005), not a migration.
- Ad-hoc operator queries against projection tables use plain `SELECT`; the MV has already deduped.

## Profiles

`polaris.profiles` holds what Polaris currently believes about each person, fed from `profile.events` through its own queue and MV (`sql/clickhouse/35`–`37`).

**One row per `(profile_id, trait_key)`, not per profile.** That follows from a decision made upstream: `profile.updated` carries CHANGED KEYS ONLY, because a full snapshot per update would multiply storage by the trait count. A table keyed per profile cannot absorb a sparse stream — each update would overwrite the whole map with just the keys that changed, and nothing about the write would look wrong.

**Current traits for one person:**

``sql
SELECT
    profile_id,
    mapFromArrays(groupArray(trait_key), groupArray(value)) AS traits,
    max(traits_version) AS traits_version
FROM polaris.profiles FINAL
WHERE project_id = {project:String}
  AND environment = {environment:String}
  AND removed = 0
GROUP BY profile_id;
``

`FINAL` collapses each `(profile, trait)` to its highest `traits_version`. `removed = 0` filters the tombstones — a trait computed to nothing is stored as a removal at the new version rather than deleted, so the collapse handles it like any other change and no mutation is needed.

`traits_version` is the version, not a timestamp. It is minted by the profile store in the same UPDATE that writes the traits, so it increments once per profile per change regardless of which writer made it. A timestamp would let two writers on clocks a second apart collapse in the wrong order and resurrect a trait the other had just removed.

### Composing with the merge dictionary

The two compose because both key on `profile_id`, which is what `profiles` is sorted by:

``sql
SELECT
    dictGetOrDefault(
        'polaris.profile_canonical', 'winner_profile_id',
        (project_id, environment, profile_id), profile_id
    ) AS canonical_profile_id,
    argMax(value, traits_version) AS value,
    trait_key
FROM polaris.profiles FINAL
WHERE project_id = {project:String}
  AND environment = {environment:String}
  AND removed = 0
GROUP BY canonical_profile_id, trait_key;
``

`argMax` inside the group is doing real work here, not decoration: after a merge, two formerly-separate profiles resolve to one canonical id and both may carry the same trait. Without `argMax(value, traits_version)` the group would pick arbitrarily between the survivor's value and the tombstoned profile's. With it, the higher version wins — which is the merge's own ordering, since the survivor kept writing after the loser stopped.

### Backfill

The stream only carries changes from the moment the sink started reading it. Profiles that existed before carry traits in PostgreSQL and no corresponding events, so a fresh `profiles` table is not a snapshot of reality — it is a snapshot of everything that has changed since.

Initial load is a one-off export from the profile plane:

``sql
-- From PostgreSQL, one row per (profile, trait):
COPY (
  SELECT project_id, environment, profile_id,
         key AS trait_key, value #>> '{}' AS value,
         0 AS removed, traits_version, updated_at
  FROM profiles, jsonb_each(traits)
  WHERE traits IS NOT NULL AND traits != '{}'::jsonb
) TO STDOUT WITH (FORMAT csv);
``

Load it into `polaris.profiles` directly, not through the queue: the queue's MV expects the `profile.updated` envelope shape, and a backfill has no events to wrap. Because the engine collapses on `traits_version`, a backfilled row and a later streamed change for the same trait resolve correctly whichever arrives first — so the backfill can run while the sink is already consuming, and does not need a maintenance window.

## Retroactive Merges

History is never rewritten. When the identity stage concludes two profiles were one person, every event already written under the losing profile stays exactly as it was — that row records what Polaris believed when it wrote it, and a delivery made under the loser's id really was made under that id. Rewriting it would make the warehouse disagree with the vendor's own record of the same delivery, and it would be a mutation over an arbitrarily large MergeTree slice besides.

Reads resolve instead. `async/merges/merge-worker/v1` consumes `identity.merged` and maintains `polaris.profile_merge_map`, which backs the `polaris.profile_canonical` dictionary (`sql/clickhouse/34_profile_merge_map.sql`).

**Every person-keyed query groups by the canonical id:**

``sql
SELECT
    dictGetOrDefault(
        'polaris.profile_canonical',
        'winner_profile_id',
        (project_id, environment, profile_id),
        profile_id
    ) AS canonical_profile_id,
    count() AS events,
    uniqExact(profile_id) AS merged_from
FROM polaris.resolved_events
WHERE project_id = {project:String}
  AND environment = {environment:String}
GROUP BY canonical_profile_id;
``

`OrDefault` is the load-bearing half: a profile that has never been merged is absent from the dictionary and resolves to itself, so the same expression is correct for every row and no query needs to know whether a merge happened. `merged_from` above is the number of historical ids that folded into one person — a column that only exists because the history was left intact.

**Do not write the shorter version.** `dictGet` without a default throws on a missing key, which means it works in testing (where every profile in the fixture has been merged) and fails on the first unmerged profile in production.

The dictionary key is a TUPLE of `(project_id, environment, profile_id)` and the layout is `COMPLEX_KEY_HASHED`. A profile id is only unique within a project and environment; a flat layout would let one project's merge resolve another project's profile.

`LIFETIME(MIN 30 MAX 60)` sets how long after a merge a person-keyed query reflects it. Seconds, deliberately: a merge is operator-visible, and an analyst who re-runs a query after one is entitled to see it. The reload is cheap because the table holds one row per merge ever performed, and profiles merge far less often than they are created.

### Chains resolve at write time

If A merges into B and later B merges into C, the map stores A→C, not A→B. A dictionary lookup cannot iterate, so a reader following the emitted rows would resolve one hop and stop — under-merging silently, with no error and a number that is merely wrong. The worker rewrites every row pointing at a newly-tombstoned profile, which puts the cost on the rare write instead of on every query.

## Replay and Rebuild

ClickHouse projection rebuilds are replay/rebuild workflows.

Rules:

- Do not manually patch projection tables as a normal fix path.
- Rebuilds should be represented as replay/rebuild jobs.
- Rebuild jobs should record source range, target tables, reason, requester, and outcome.
- `analytics_ingest_log` helps diagnose duplicate or repeated ingestion.
- `analytics_raw` should be the normal base for analytical projections.
