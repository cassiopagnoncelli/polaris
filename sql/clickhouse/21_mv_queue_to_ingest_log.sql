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

CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.analytics_mv_queue_to_ingest_log
ON CLUSTER '{cluster}'
TO polaris.analytics_ingest_log
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
