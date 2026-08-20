-- Polaris ClickHouse: MV that flattens derived-event queue rows into
-- analytics_processed.
--
-- The only sanctioned reader of polaris.analytics_processed_queue.
-- Mirrors 31_mv_queue_to_raw.sql: extract the envelope's nested JSON
-- objects into typed columns so downstream queries avoid per-row JSON
-- parsing.
--
-- No filtering. The sink decides which queue table a message goes to, so
-- by the time a row reaches this view the routing question is already
-- answered — see the note on 11_analytics_processed_queue.sql.
--
-- Dedupe is NOT applied here. Duplicates are absorbed by
-- ReplacingMergeTree's merge-time collapse and by argMax(_version) in
-- any downstream projection MV.

-- SQL SECURITY NONE: the MV's SELECT is not privilege-checked.
--
-- Same reasoning as the two queue MVs. Without this clause the SELECT
-- runs as the inserting user — `polaris_sink`, which holds INSERT and
-- deliberately no SELECT anywhere — so every insert fails with
-- ACCESS_DENIED "while pushing to view", and because the sink rolls its
-- checkpoint back on a failed batch, nothing ever reaches ClickHouse.
CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.analytics_mv_processed_queue_to_processed
ON CLUSTER '{cluster}'
TO polaris.analytics_processed
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

    -- source.{id,type} — the processor that concluded this fact.
    -- sdk / sdk_version are not extracted: a derived event is never
    -- emitted by an SDK, and both are null on every envelope here.
    JSONExtractString(source, 'id')   AS source_id,
    JSONExtractString(source, 'type') AS source_type,

    -- identity.{anonymous_id,session_id,customer_id,device_id} — carried
    -- forward from the source event, never invented by the processor.
    JSONExtractString(identity, 'anonymous_id') AS anonymous_id,
    JSONExtractString(identity, 'session_id')   AS session_id,
    JSONExtractString(identity, 'customer_id')  AS customer_id,
    JSONExtractString(identity, 'device_id')    AS device_id,

    properties AS properties_json,
    context    AS context_json,
    consent    AS consent_json,
    privacy    AS privacy_json,

    processor_name,
    processor_version,
    -- _version fallback, matching 31_mv_queue_to_raw.sql: producers
    -- should populate _version, but if they omit it (zero value) fall
    -- back to the ingest timestamp so ReplacingMergeTree's collapse
    -- still sees a monotonic value.
    if(_version = 0, toUnixTimestamp64Milli(ingested_at), _version) AS _version,

    _topic     AS _topic,
    _partition AS _partition,
    _offset    AS _offset
FROM polaris.analytics_processed_queue;
