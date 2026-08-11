-- Polaris ClickHouse: deduped derived-fact table
--
-- The consolidated analytical table for everything Polaris *concludes*,
-- as opposed to everything producers *report* (which is analytics_raw).
-- One table for all four derived families rather than four tables:
-- they share the canonical envelope, they are queried together far more
-- often than separately ("what did we derive for this session"), and the
-- `event` column is already in the sort key, so a per-family table would
-- buy nothing a WHERE does not.
--
-- Populated by 33_mv_processed_queue_to_processed.sql from
-- polaris.analytics_processed_queue.
--
-- Engine:
--   {replicated}ReplacingMergeTree(_version) expands to:
--     ReplacingMergeTree(_version)            (local/dev)
--     ReplicatedReplacingMergeTree(_version)  (production)
--
-- Dedup key: ORDER BY (project_id, environment, event, event_id) —
--   identical to analytics_raw, so the same query patterns apply
--   verbatim. Derived events carry deterministic event_ids (a replay of
--   the same input reproduces the same id), which is what makes
--   ReplacingMergeTree the right engine here and not just an inherited
--   default.
--
-- TTL:
--   400 days, matching analytics_raw. Derived facts are only meaningful
--   alongside the source events they were derived from, so a shorter TTL
--   here would silently break joins before the source rows expired.
--
-- Query rules: identical to analytics_raw. This table is raw-tier, not a
-- projection — it is NOT granted to polaris_service, and it is never
-- queried without argMax / `SETTINGS final = 1` / count(DISTINCT
-- event_id). See docs/architecture/07-clickhouse.md "Query Patterns".
--
-- ## Columns deliberately absent
--
-- `ip`, `user_agent` and `locale` are flattened onto analytics_raw but
-- not here. Processors strip the source IP when they emit — the geoip
-- enricher forwards a SHA-256 hash in `properties` and an empty context
-- precisely so raw IP lives on exactly one record. Materialising an `ip`
-- column that is structurally always empty would invite a query that
-- reads as "no IPs observed" rather than "IPs are not on this table".

CREATE TABLE IF NOT EXISTS polaris.analytics_processed ON CLUSTER '{cluster}'
(
    event_id          String,
    event             LowCardinality(String),
    schema_version    UInt32,
    project_id        LowCardinality(String),
    environment       LowCardinality(String),
    occurred_at       DateTime64(3, 'UTC'),
    ingested_at       DateTime64(3, 'UTC'),

    -- Which processor concluded this fact. `source_type` is 'internal'
    -- for every row here by construction; `source_id` is the processor
    -- name, which is the column operators actually filter on.
    source_id         LowCardinality(String),
    source_type       LowCardinality(String),

    -- Identity block, carried forward from the source event unchanged.
    -- These are the join keys back to analytics_raw.
    anonymous_id      String,
    session_id        String,
    customer_id       String,
    device_id         String,

    -- The derived payload. This is the point of the table: the geoip
    -- result, the session window, the identity link, the touchpoint.
    properties_json   String,
    context_json      String,
    consent_json      String,
    privacy_json      String,

    processor_name    LowCardinality(String),
    processor_version LowCardinality(String),

    -- ReplacingMergeTree version column.
    _version          UInt64,

    -- Transport lineage. analytics_raw does not carry these because
    -- analytics_ingest_log does; the derived path has no ingest log, so
    -- the lineage rides on the fact table instead. Without it there is
    -- no way to answer "which stream offset produced this row" during a
    -- replay investigation.
    --
    -- Note the consequence: because this is a ReplacingMergeTree, a
    -- duplicate delivery collapses at merge time and its lineage
    -- disappears with it. Duplicate-delivery forensics for derived
    -- events therefore rely on the sink's metrics, not on this table.
    _topic            LowCardinality(String),
    _partition        UInt16,
    _offset           UInt64
)
ENGINE = {replicated}ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, environment, event, event_id)
TTL toDateTime(occurred_at) + INTERVAL 400 DAY
SETTINGS index_granularity = 8192;
