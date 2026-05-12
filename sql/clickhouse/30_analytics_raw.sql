-- Polaris ClickHouse: deduped analytical raw table
--
-- This is the canonical analytical fact table. Every projection MV
-- reads from here; dashboard queries do NOT read from here without
-- explicit dedupe.
--
-- Engine:
--   {replicated}ReplacingMergeTree(_version) expands to:
--     ReplacingMergeTree(_version)            (local/dev)
--     ReplicatedReplacingMergeTree(_version)  (production)
--
--   Production ClickHouse uses server-level `default_replica_path`
--   and `default_replica_name` macros so the engine spec needs only
--   the version column. See infra/clickhouse/config.d/.
--
-- Dedup key: ORDER BY (project_id, environment, event, event_id).
--   ReplacingMergeTree collapses rows that share this key at merge
--   time, keeping the one with the highest _version. Between merges
--   duplicates coexist — see docs/architecture/07-clickhouse.md
--   "Query Patterns".
--
-- _version:
--   Monotonic per-event-key revision. Set by the analytics processor
--   when it writes to `analytics.events`. Defaults to ingestion ms
--   in the Kafka Engine table so out-of-band replays still produce
--   stable orderings.
--
-- TTL:
--   400 days, matching the production-readiness data lifecycle
--   defaults.
--
-- Query rules (enforced by ClickHouse roles + the shared-clickhouse
-- helper package; see docs/architecture/07-clickhouse.md "Access
-- Control"):
--   * MVs use argMax(col, _version) GROUP BY (project_id,
--     environment, event, event_id) — never FINAL.
--   * Ad-hoc operator queries use `SETTINGS final = 1` — the
--     keyword `FINAL` is reserved for the documented escape hatch.
--   * Count-distinct queries use `count(DISTINCT event_id)`.

CREATE TABLE IF NOT EXISTS polaris.analytics_raw ON CLUSTER '{cluster}'
(
    event_id          String,
    event             LowCardinality(String),
    schema_version    UInt32,
    project_id        LowCardinality(String),
    environment       LowCardinality(String),
    occurred_at       DateTime64(3, 'UTC'),
    ingested_at       DateTime64(3, 'UTC'),

    -- Flattened source / identity / context (parsed from JSON in the
    -- MV that feeds this table). Keeping them as typed columns lets
    -- projection MVs avoid JSON parsing on the hot path.
    source_id         LowCardinality(String),
    source_type       LowCardinality(String),
    sdk               LowCardinality(String),
    sdk_version       LowCardinality(String),

    anonymous_id      String,
    session_id        String,
    customer_id       String,
    device_id         String,

    ip                String,
    user_agent        String,
    locale            LowCardinality(String),

    -- Free-form JSON survives for projection-time extraction.
    properties_json   String,
    context_json      String,
    consent_json      String,
    privacy_json      String,

    -- Processor metadata that emitted this analytical event.
    processor_name    LowCardinality(String),
    processor_version LowCardinality(String),

    -- ReplacingMergeTree version column.
    _version          UInt64
)
ENGINE = {replicated}ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, environment, event, event_id)
TTL toDateTime(occurred_at) + INTERVAL 400 DAY
SETTINGS index_granularity = 8192;
