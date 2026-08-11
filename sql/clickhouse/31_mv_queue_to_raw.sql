-- Polaris ClickHouse: MV that flattens queue rows into analytics_raw.
--
-- Second sanctioned reader of polaris.analytics_events_queue. The MV
-- extracts the envelope's nested JSON objects (source, identity,
-- context, ...) into typed columns so projection MVs can avoid
-- per-row JSON parsing.
--
-- Dedupe is NOT applied here. Duplicates are absorbed by
-- ReplacingMergeTree's merge-time collapse and by argMax(_version)
-- in downstream projection MVs.

CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.analytics_mv_queue_to_raw
ON CLUSTER '{cluster}'
TO polaris.analytics_raw
AS
SELECT
    event_id,
    event,
    schema_version,
    project_id,
    environment,
    occurred_at,
    ingested_at,

    -- source.{id,type,sdk,sdk_version}
    JSONExtractString(source, 'id')          AS source_id,
    JSONExtractString(source, 'type')        AS source_type,
    JSONExtractString(source, 'sdk')         AS sdk,
    JSONExtractString(source, 'sdk_version') AS sdk_version,

    -- identity.{anonymous_id,session_id,customer_id,device_id}
    JSONExtractString(identity, 'anonymous_id') AS anonymous_id,
    JSONExtractString(identity, 'session_id')   AS session_id,
    JSONExtractString(identity, 'customer_id')  AS customer_id,
    JSONExtractString(identity, 'device_id')    AS device_id,

    -- context.{ip,user_agent,locale}
    JSONExtractString(context, 'ip')         AS ip,
    JSONExtractString(context, 'user_agent') AS user_agent,
    JSONExtractString(context, 'locale')     AS locale,

    properties AS properties_json,
    context    AS context_json,
    consent    AS consent_json,
    privacy    AS privacy_json,

    processor_name,
    processor_version,
    -- _version defaulting moved here from the queue table: CH 25+ rejects
    -- DEFAULT on the ingestion interface table columns. Producers should populate _version,
    -- but if they omit it (zero value) we fall back to the ingest timestamp
    -- so ReplacingMergeTree's collapse logic in analytics_raw still sees
    -- a monotonic value.
    if(_version = 0, toUnixTimestamp64Milli(ingested_at), _version) AS _version
FROM polaris.analytics_events_queue;
