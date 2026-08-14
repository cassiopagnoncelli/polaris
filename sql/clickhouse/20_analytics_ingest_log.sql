-- Polaris ClickHouse: append-only ingestion log
--
-- Purpose (see docs/architecture/07-clickhouse.md, "Two-Layer Raw
-- Storage / analytics_ingest_log"):
--   * Preserve what ClickHouse consumed from `analytics.events`.
--   * Make duplicate delivery visible.
--   * Separate transport truth (this table) from analytical truth
--     (analytics_raw).
--
-- Append-only by construction. No dedupe applied here — rows reflect
-- the exact stream as ClickHouse saw it. Duplicates are expected and
-- diagnostic; do not "fix" them in this table.
--
-- Engine:
--   {replicated}MergeTree expands to either
--     MergeTree              (local/dev: empty {replicated} macro)
--     ReplicatedMergeTree    (production: {replicated} = 'Replicated')
--
--   Production ClickHouse must configure server-level
--   `default_replica_path` and `default_replica_name` so the engine
--   spec needs no explicit zookeeper-path / replica-name arguments.
--   See infra/clickhouse/config.d/macros-production.xml.
--
-- TTL:
--   30 days, matching docs/architecture/11-production-readiness.md
--   "Data Lifecycle Defaults / ClickHouse".

CREATE TABLE IF NOT EXISTS polaris.analytics_ingest_log ON CLUSTER '{cluster}'
(
    event_id          String,
    event             LowCardinality(String),
    schema_version    UInt32,
    project_id        LowCardinality(String),
    environment       LowCardinality(String),
    occurred_at       DateTime64(3, 'UTC'),
    ingested_at       DateTime64(3, 'UTC'),
    source            String,
    identity          String,
    context           String,
    consent           String,
    privacy           String,
    properties        String,
    processor_name    LowCardinality(String),
    processor_version LowCardinality(String),
    -- The `profile` block as delivered. This table is the PARITY surface
    -- for the M3 dual-run — the only place the same event_id from both
    -- feeds coexists as two rows rather than collapsing — so it has to
    -- carry the field that tells them apart.
    profile           String    DEFAULT '',
    _version          UInt64,

    -- Diagnostic columns: filled by the MV that reads from the ingestion
    -- Engine table. These let operators trace a row back to the
    -- transport partition/offset without re-parsing JSON.
    _consumed_at      DateTime64(3, 'UTC') DEFAULT now64(3),
    _topic            LowCardinality(String) DEFAULT '',
    _partition        UInt32 DEFAULT 0,
    _offset           UInt64 DEFAULT 0
)
ENGINE = {replicated}MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (project_id, environment, ingested_at, event_id)
TTL toDateTime(ingested_at) + INTERVAL 30 DAY
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

ALTER TABLE polaris.analytics_ingest_log ON CLUSTER '{cluster}'
    ADD COLUMN IF NOT EXISTS profile String DEFAULT '' AFTER processor_version;
