-- Polaris ClickHouse: projection table
-- session_daily_metrics
--
-- First projection over analytics_processed, and the reason the derived
-- path exists: sessions are the question you could not answer before.
-- `analytics_raw.session_id` is whatever the client claimed, because the
-- source envelope is written before the sessionizer ever sees it. The
-- sessionizer's actual verdict lives in `session.started` / `session.ended`
-- on `session.events`, which now lands in analytics_processed.
--
-- Engine: {replicated}SummingMergeTree.
--   Rationale: pre-summed counters keyed by (project_id, environment,
--   occurred_date). The feeder MV emits one row per session event with a
--   1 in the matching column; SummingMergeTree collapses them into daily
--   totals at merge time.
--
--   Picked per docs/architecture/07-clickhouse.md "Projection Tables /
--   Engine Selection Methodology":
--     MergeTree              -> fact rows
--     SummingMergeTree       -> pre-summed counters by group key  <-- this
--     AggregatingMergeTree   -> complex aggregate states
--
-- Why two counters rather than a single `sessions` column with a sign:
-- a session that starts in one day and ends in the next is normal, so
-- started and ended are genuinely different daily quantities and their
-- difference over a window is the open-session count. Collapsing them
-- would destroy that.
--
-- Note `event` is NOT in the sort key, unlike event_daily_counts. The
-- event name is already encoded by which counter a row contributes to,
-- so keying on it would split every day into two rows that always get
-- summed back together.
--
-- Query patterns:
--   SELECT project_id, environment, occurred_date,
--          sum(sessions_started) AS started,
--          sum(sessions_ended)   AS ended
--   FROM polaris.session_daily_metrics
--   WHERE project_id = ? AND occurred_date >= ?
--   GROUP BY project_id, environment, occurred_date
--   ORDER BY occurred_date;
--
--   The outer sum() is the same defensive idiom event_daily_counts uses:
--   SummingMergeTree collapses at merge time, so concurrent inserts may
--   briefly show ungrouped rows.

CREATE TABLE IF NOT EXISTS polaris.session_daily_metrics ON CLUSTER '{cluster}'
(
    project_id        LowCardinality(String),
    environment       LowCardinality(String),
    occurred_date     Date,
    sessions_started  UInt64,
    sessions_ended    UInt64
)
ENGINE = {replicated}SummingMergeTree((sessions_started, sessions_ended))
PARTITION BY toYYYYMM(occurred_date)
ORDER BY (project_id, environment, occurred_date)
TTL occurred_date + INTERVAL 400 DAY
SETTINGS index_granularity = 8192;
