-- Polaris ClickHouse: projection table
-- event_daily_counts
--
-- Skeletal projection demonstrating the canonical Polaris dedupe
-- pattern: an argMax-based MV (see
-- materialized-views/41_mv_raw_to_event_daily_counts.sql) reads from
-- analytics_raw, deduplicates per (project_id, environment, event,
-- event_id) using argMax(_version), and writes already-deduped rows
-- here. Dashboards SELECT from this table directly — no FINAL, no
-- argMax, no DISTINCT — because the MV already collapsed duplicates.
--
-- Engine: {replicated}SummingMergeTree.
--   Rationale: this is a pre-summed counter keyed by (project_id,
--   environment, event, occurred_date). When the MV inserts
--   per-event counts, SummingMergeTree collapses rows with the same
--   key by summing the numeric columns at merge time, giving stable
--   daily totals without per-query aggregation.
--
--   Picked per docs/architecture/07-clickhouse.md "Projection Tables
--   / Engine Selection Methodology":
--     MergeTree              -> fact rows
--     SummingMergeTree       -> pre-summed counters by group key  <-- this
--     AggregatingMergeTree   -> complex aggregate states
--
-- Query patterns:
--   SELECT project_id, environment, event, occurred_date,
--          sum(event_count) AS events
--   FROM polaris.event_daily_counts
--   WHERE project_id = ? AND occurred_date >= ?
--   GROUP BY project_id, environment, event, occurred_date
--   ORDER BY occurred_date;
--
--   The outer sum() is a defensive idiom: SummingMergeTree only
--   collapses at merge time, so concurrent inserts may briefly show
--   ungrouped rows. sum() over the group key is cheap and correct.

CREATE TABLE IF NOT EXISTS polaris.event_daily_counts ON CLUSTER '{cluster}'
(
    project_id     LowCardinality(String),
    environment    LowCardinality(String),
    event          LowCardinality(String),
    occurred_date  Date,
    event_count    UInt64
)
ENGINE = {replicated}SummingMergeTree(event_count)
PARTITION BY toYYYYMM(occurred_date)
ORDER BY (project_id, environment, event, occurred_date)
TTL occurred_date + INTERVAL 400 DAY
SETTINGS index_granularity = 8192;
