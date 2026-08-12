-- Polaris ClickHouse: MV that drains the DERIVED ingestion interface
-- table into the same append-only ingest log the source path uses.
--
-- Sibling of 21_mv_queue_to_ingest_log.sql. Same target table, same
-- verbatim-preservation rule, different source queue.
--
-- ## Why the ingest log spans both paths
--
-- `analytics_ingest_log` records what ClickHouse consumed. When the
-- derived path landed it recorded only half of that, which made the
-- table's name a small lie and left one real gap: duplicate-delivery
-- forensics. Derived events collapse in `analytics_processed`'s
-- ReplacingMergeTree, and the surviving row's lineage collapses with
-- them, so "was this delivered twice" had no answer for four of the five
-- families the sink reads.
--
-- This costs one MV and no new table. The alternative considered and
-- rejected was a second, derived-only ingest log: it would double the
-- operator's lookup ("which log do I grep?") to buy nothing, since the
-- `_topic` column already says which stream a row came from and the
-- `event` column already says what it is.
--
-- Volume note: the log's TTL is 30 days and it now carries both paths,
-- so its footprint grows by roughly the derived-event rate. That is the
-- intended trade — 30 days of complete transport truth beats 30 days of
-- half of it.
--
-- SQL SECURITY NONE: same reasoning as every other Polaris MV. Without
-- it the SELECT runs as the inserting user — `polaris_sink`, which holds
-- INSERT and no SELECT anywhere — so every insert fails with
-- ACCESS_DENIED "while pushing to view", and because the sink rolls its
-- checkpoint back on a failed batch, nothing ever reaches ClickHouse.
CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.analytics_mv_processed_queue_to_ingest_log
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
    -- Same `_version` fallback as the source path: producers should
    -- populate it, but a zero value falls back to the ingest timestamp so
    -- ordering stays monotonic.
    if(_version = 0, toUnixTimestamp64Milli(ingested_at), _version) AS _version,
    now64(3)        AS _consumed_at,
    _topic          AS _topic,
    _partition      AS _partition,
    _offset         AS _offset
FROM polaris.analytics_processed_queue;
