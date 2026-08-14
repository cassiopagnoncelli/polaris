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
CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.analytics_mv_queue_to_raw
ON CLUSTER '{cluster}'
TO polaris.analytics_raw
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

    -- profile.{profile_id,traits_version}, stamped by the spine. Absent
    -- on the legacy `analytics.events` feed, and null on events the
    -- identity stage could not resolve to a person — JSONExtract yields
    -- '' / 0 for both, which is the intended reading of "no person here".
    JSONExtractString(profile, 'profile_id')      AS profile_id,
    JSONExtractUInt(profile, 'traits_version')    AS traits_version,

    -- The sink now builds _version explicitly (stage rank in the high
    -- bits, ingest ms in the low bits — see 30_analytics_raw.sql). This
    -- fallback stays for writers that bypass the sink: a hand-run
    -- backfill or an out-of-band replay inserting straight into the
    -- queue table still collapses monotonically instead of pinning every
    -- row at zero. Rank 0 IS this expression, so a legacy row and a
    -- fallback row sort identically.
    if(_version = 0, toUnixTimestamp64Milli(ingested_at), _version) AS _version
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

ALTER TABLE polaris.analytics_mv_queue_to_raw ON CLUSTER '{cluster}'
MODIFY QUERY
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

    -- profile.{profile_id,traits_version}, stamped by the spine. Absent
    -- on the legacy `analytics.events` feed, and null on events the
    -- identity stage could not resolve to a person — JSONExtract yields
    -- '' / 0 for both, which is the intended reading of "no person here".
    JSONExtractString(profile, 'profile_id')      AS profile_id,
    JSONExtractUInt(profile, 'traits_version')    AS traits_version,

    -- The sink now builds _version explicitly (stage rank in the high
    -- bits, ingest ms in the low bits — see 30_analytics_raw.sql). This
    -- fallback stays for writers that bypass the sink: a hand-run
    -- backfill or an out-of-band replay inserting straight into the
    -- queue table still collapses monotonically instead of pinning every
    -- row at zero. Rank 0 IS this expression, so a legacy row and a
    -- fallback row sort identically.
    if(_version = 0, toUnixTimestamp64Milli(ingested_at), _version) AS _version
FROM polaris.analytics_events_queue;
