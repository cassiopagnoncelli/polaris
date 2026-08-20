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
--   Monotonic per-event-key revision, deciding which copy of a fact
--   survives the collapse. Built by the clickhouse-sink as
--
--       (stage_rank * 2^48) + ingested_at_ms
--
--   where stage_rank is 0 for the legacy `analytics.events` feed and 1
--   for the spine's `resolved.events`. See
--   libs/persistence/clickhouse/src/version.ts for the full rationale.
--
--   Three consequences, each deliberate:
--     * during the M3 dual-run the same event arrives on both feeds with
--       the same event_id and the same ingested_at, so without a rank
--       they would tie and ReplacingMergeTree would pick arbitrarily —
--       half the surviving rows missing the profile columns. The rank
--       makes the enriched row win every time.
--     * rank 0 reproduces the MVs' old `ingested_at` fallback exactly,
--       so rows merged before this scheme existed sort identically
--       under it and nothing needs backfilling.
--     * the value is a pure function of (stage, ingested_at), and the
--       spine preserves ingested_at verbatim, so a replay re-derives the
--       same number and collapses onto the original instead of
--       ratcheting the version forward on every rerun.
--
--   The MVs keep their `if (_version = 0, toUnixTimestamp64Milli(...))`
--   guard for writers that bypass the sink; the sink itself no longer
--   emits 0.
--
-- TTL:
--   400 days, matching the production-readiness data lifecycle
--   defaults.
--
-- Query rules (enforced by ClickHouse roles + the persistence-clickhouse
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

    -- The person this event belongs to, resolved by the identity stage
    -- and extracted from the envelope's `profile` block. Empty string
    -- for rows from the legacy `analytics.events` feed (no profile
    -- plane behind it) and for events the spine could not resolve to a
    -- person — both are real states, and neither is an error.
    --
    -- Not in the sort key. The key is the DEDUPE key, and profile_id is
    -- mutable: a merge repoints a person's identifiers, so keying on it
    -- would make the same event dedupe differently before and after a
    -- merge. Person-keyed reads join through the merge dictionary (R4)
    -- instead.
    profile_id        String    DEFAULT '',
    -- The traits snapshot's version at the moment this event was
    -- enriched, which is what makes a historical delivery explainable
    -- after the profile has moved on. 0 when no snapshot was carried.
    traits_version    UInt64    DEFAULT 0,

    -- ReplacingMergeTree version column.
    _version          UInt64
)
ENGINE = {replicated}ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (project_id, environment, event, event_id)
TTL toDateTime(occurred_at) + INTERVAL 400 DAY
SETTINGS index_granularity = 8192;

-- --------------------------------------------------------------------
-- Additive migration (M3 profile columns).
--
-- `CREATE ... IF NOT EXISTS` above is idempotent for a FRESH database:
-- run it twice, get one table. It is not idempotent for a schema CHANGE
-- — against a database that already has this object it does nothing at
-- all, silently and successfully, and without the new columns.
--
-- So each file carries its own migration, immediately after the
-- definition it amends. Ordering then takes care of itself: the file
-- that owns a table adds the table's columns before any later file
-- reads them. A central migration file cannot do that — it would have
-- to sort after every CREATE and before every MV that selects the new
-- column, and those two constraints have no common solution.
-- --------------------------------------------------------------------

ALTER TABLE polaris.analytics_raw ON CLUSTER '{cluster}'
    ADD COLUMN IF NOT EXISTS profile_id String DEFAULT '' AFTER processor_version;

ALTER TABLE polaris.analytics_raw ON CLUSTER '{cluster}'
    ADD COLUMN IF NOT EXISTS traits_version UInt64 DEFAULT 0 AFTER profile_id;
