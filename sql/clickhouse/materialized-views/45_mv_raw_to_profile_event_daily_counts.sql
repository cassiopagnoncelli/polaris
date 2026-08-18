-- Polaris ClickHouse MV: analytics_raw -> profile_event_daily_counts.
--
-- The person-dimensioned twin of 41_mv_raw_to_event_daily_counts.sql.
-- Everything that file says about at-least-once counting applies here
-- unchanged: one distinct event_id contributes one per INSERT block,
-- SummingMergeTree collapses at merge time, and cross-block duplicates
-- over-count until the rebuild path re-derives the figure in one pass.
--
-- SQL SECURITY NONE for the same reason: without it the SELECT runs as
-- `polaris_sink`, which holds INSERT on the interface tables and SELECT on
-- nothing, so every insert fails "while pushing to view" and the sink
-- rolls its checkpoint back forever.
--
-- ## Rows with no person are dropped, not stored empty
--
-- Events predating the spine carry no `profile_id`, and anonymous traffic
-- carries no `customer_id`. A row keyed on an empty string would be a
-- bucket labelled "everyone we could not identify", which every reader
-- would have to remember to exclude — and the first one to forget gets an
-- LTV for a customer who is the sum of all strangers.
--
-- The filter is on `profile_id` alone: it is what the spine resolves and
-- what traits key on. An identified event always has one; `customer_id`
-- may still be empty for a profile known only by an anonymous id, and
-- that row is useful to a trait even though no writeback can key on it.

CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.mv_raw_to_profile_event_daily_counts
ON CLUSTER '{cluster}'
TO polaris.profile_event_daily_counts
SQL SECURITY NONE
AS
SELECT
    project_id,
    environment,
    profile_id,
    argMax(customer_id, _version) AS customer_id,
    event,
    toDate(argMax(occurred_at, _version)) AS occurred_date,
    toUInt64(1) AS event_count
FROM polaris.analytics_raw
WHERE profile_id != ''
GROUP BY
    project_id,
    environment,
    profile_id,
    event,
    event_id;
