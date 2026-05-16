-- Polaris ClickHouse: MV that drains the Kafka Engine queue into the
-- append-only ingest log.
--
-- This is one of the two sanctioned readers of
-- polaris.analytics_events_queue. Application code MUST NOT SELECT
-- from the queue directly.
--
-- The MV preserves transport truth verbatim. No filtering, no
-- deduplication, no transformation beyond stamping diagnostic
-- columns. Duplicate Kafka delivery shows up as duplicate rows here,
-- which is the entire point of the ingest log.

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
    -- _version defaulting moved here from the queue table: CH 25+ rejects
    -- DEFAULT on Kafka Engine columns. Producers should populate _version,
    -- but if they omit it (zero value) we fall back to the ingest timestamp
    -- so ReplacingMergeTree's collapse logic still sees a monotonic value.
    if(_version = 0, toUnixTimestamp64Milli(ingested_at), _version) AS _version,
    -- Kafka Engine virtual columns. These are populated by ClickHouse
    -- for each row pulled from the underlying Kafka consumer.
    now64(3)        AS _consumed_at,
    _topic          AS _topic,
    _partition      AS _partition,
    _offset         AS _offset
FROM polaris.analytics_events_queue;
