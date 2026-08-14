-- Polaris ClickHouse: MV that drains the ingestion interface table into
-- the append-only ingest log.
--
-- This is one of the two sanctioned readers of
-- polaris.analytics_events_queue. Application code MUST NOT SELECT
-- from the queue directly.
--
-- The MV preserves transport truth verbatim. No filtering, no
-- deduplication, no transformation beyond stamping diagnostic
-- columns. A re-inserted batch (clickhouse-sink retrying after a crash)
-- shows up as duplicate rows here, which is the entire point of the
-- ingest log.

-- SQL SECURITY NONE: the MV's SELECT is not privilege-checked.
--
-- A materialized view without this clause runs its SELECT as the user
-- performing the INSERT. That user is `polaris_sink`, which holds INSERT
-- on the ingestion interface table and — deliberately, per
-- sql/clickhouse/roles/01_grants.sql — SELECT on nothing at all. So every
-- INSERT the sink made failed with ACCESS_DENIED "while pushing to view",
-- and because the sink rolls its checkpoint back on a failed batch,
-- nothing ever reached ClickHouse.
--
-- `NONE` rather than a `DEFINER` user because the definer would have to be
-- a principal that exists before this file runs, and MVs are applied in
-- phase 2 while users are provisioned in phase 3 (local) or by the secret
-- provider (production). `NONE` grants no new read path to anyone: the
-- statement below is fixed, version-controlled DDL that can only move
-- queue rows into their target table, and `polaris_sink` still cannot
-- SELECT a single row itself.
CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.analytics_mv_queue_to_ingest_log
ON CLUSTER '{cluster}'
TO polaris.analytics_ingest_log
SQL SECURITY NONE
AS
SELECT
    event_id,
    event,
    schema_version,
    project_id,
    environment,
    occurred_at,
    ingested_at,
    source,
    identity,
    context,
    consent,
    privacy,
    properties,
    processor_name,
    processor_version,
    profile,
    -- _version fallback. Producers should populate _version, but if they
    -- omit it (zero value) we fall back to the ingest timestamp so
    -- ReplacingMergeTree's collapse logic still sees a monotonic value.
    if(_version = 0, toUnixTimestamp64Milli(ingested_at), _version) AS _version,
    -- Transport lineage, stamped by clickhouse-sink on INSERT. These
    -- were Kafka Engine virtual columns; the names are unchanged so
    -- every existing lineage query still resolves.
    now64(3)        AS _consumed_at,
    _topic          AS _topic,
    _partition      AS _partition,
    _offset         AS _offset
FROM polaris.analytics_events_queue;

-- --------------------------------------------------------------------
-- Additive migration (M3 profile columns).
--
-- `CREATE MATERIALIZED VIEW IF NOT EXISTS` is a no-op against a view
-- that already exists, so an existing database would keep the OLD body
-- and never select the new column. `MODIFY QUERY` re-applies the
-- definition above.
--
-- MODIFY QUERY rather than DROP + CREATE, deliberately: a dropped MV is
-- not reading while it is gone, and every row the sink inserts in that
-- window reaches neither its target table nor the ingest log. The source
-- is a Null engine, so there is nothing to replay from — silent,
-- unrecoverable loss during a schema migration. MODIFY QUERY swaps the
-- definition with no such gap.
-- --------------------------------------------------------------------

ALTER TABLE polaris.analytics_mv_queue_to_ingest_log ON CLUSTER '{cluster}'
MODIFY QUERY
SELECT
    event_id,
    event,
    schema_version,
    project_id,
    environment,
    occurred_at,
    ingested_at,
    source,
    identity,
    context,
    consent,
    privacy,
    properties,
    processor_name,
    processor_version,
    profile,
    -- _version fallback. Producers should populate _version, but if they
    -- omit it (zero value) we fall back to the ingest timestamp so
    -- ReplacingMergeTree's collapse logic still sees a monotonic value.
    if(_version = 0, toUnixTimestamp64Milli(ingested_at), _version) AS _version,
    -- Transport lineage, stamped by clickhouse-sink on INSERT. These
    -- were Kafka Engine virtual columns; the names are unchanged so
    -- every existing lineage query still resolves.
    now64(3)        AS _consumed_at,
    _topic          AS _topic,
    _partition      AS _partition,
    _offset         AS _offset
FROM polaris.analytics_events_queue;
