-- Polaris ClickHouse projection: per-profile daily event counts.
--
-- The person-dimensioned sibling of `event_daily_counts`. Same grain plus
-- `profile_id` and `customer_id`, which is what makes a PER-PERSON
-- aggregate expressible at all.
--
-- ## Why a second table and not a column on the first
--
-- `event_daily_counts` answers "how much traffic did this project see",
-- and every dashboard reads it. Adding a person to its sort key would
-- multiply its rows by active profiles per day — from one row per
-- (project, env, event, day) to one per person — and make every dashboard
-- query aggregate over a table three or four orders of magnitude larger
-- to get an answer that never mentions a person.
--
-- Two tables, two access patterns, two cardinalities. The cheap rollup
-- stays cheap.
--
-- ## Why this table has to exist
--
-- Before it, NO per-profile trait was computable. The trait catalog's
-- allowlist permitted `event_daily_counts` and `session_daily_metrics`,
-- and neither carried a person — so the shipped `orders_30d` trait, which
-- selects `profile_id`, had never produced a row, and the
-- `recent_purchasers` audience reading that trait was empty by
-- construction. See scripts/check-catalog-sql.mjs, which now runs every
-- catalog definition against the real schema for exactly this reason.
--
-- ## Both identifiers, deliberately
--
-- `profile_id` is what a TRAIT keys on: traits attach to the profile the
-- spine resolved. `customer_id` is what a REVERSE-ETL writeback keys on,
-- because the event it emits carries an identity for the identity stage
-- to resolve — a profile id captured in a job would go stale the moment
-- two profiles merged.
--
-- Rows predating the spine carry neither, and are excluded by the MV
-- rather than stored as empty: a projection row for a person nobody can
-- name is a row every reader has to filter.
--
-- ## Over-counting, same as its sibling
--
-- SummingMergeTree sums per insert block and `event_id` is aggregated
-- away, so cross-block duplicates over-count. The platform is
-- at-least-once by design and the rebuild path re-derives exact figures in
-- one pass. See 41_mv_raw_to_event_daily_counts.sql, which explains the
-- mechanism at length.
--
-- ## Retention
--
-- 400 days, matching `event_daily_counts`. A trait windowed on 30 or 90
-- days needs far less, but the ceiling is set by the longest window a
-- definition may declare, not the shortest.

CREATE TABLE IF NOT EXISTS polaris.profile_event_daily_counts ON CLUSTER '{cluster}'
(
    project_id     LowCardinality(String),
    environment    LowCardinality(String),
    profile_id     String,
    customer_id    String,
    event          LowCardinality(String),
    occurred_date  Date,
    event_count    UInt64
)
ENGINE = {replicated}SummingMergeTree(event_count)
PARTITION BY toYYYYMM(occurred_date)
-- Profile first after the scope: every reader of this table asks about a
-- PERSON, and a trait's GROUP BY profile_id then reads one contiguous
-- range per person instead of scanning the day.
ORDER BY (project_id, environment, profile_id, event, occurred_date)
TTL occurred_date + INTERVAL 400 DAY
SETTINGS index_granularity = 8192;
