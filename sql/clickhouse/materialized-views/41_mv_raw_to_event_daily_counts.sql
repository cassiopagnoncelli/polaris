-- Polaris ClickHouse: argMax-based MV that feeds event_daily_counts.
--
-- Reads insert blocks landing in polaris.analytics_raw and emits
-- already-deduped per-day event counts into the projection table.
--
-- The dedupe pattern (docs/architecture/07-clickhouse.md "Query
-- Patterns / Pattern 1") is:
--
--   GROUP BY (project_id, environment, event, event_id)
--   argMax(<col>, _version)
--
-- argMax(col, _version) returns the value of `col` from the row
-- with the highest _version within the group. This is functionally
-- equivalent to what ReplacingMergeTree would emit after a merge
-- and is the project-wide replacement for FINAL.
--
-- Important: a ClickHouse MV "sees" only the newly inserted block,
-- not the full state of the source table. The argMax over event_id
-- here collapses duplicates that arrive in the same insert block;
-- duplicates across blocks are folded by SummingMergeTree on the
-- projection side (rows with the same (project_id, environment,
-- event, occurred_date) get their event_count summed at merge time).
--
-- If the projection ever needs strict at-most-once-per-event-id
-- guarantees across blocks, the rebuild path (P7-005) re-derives
-- this projection by reading analytics_raw with the argMax pattern
-- in a single pass — not by adding FINAL here.

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
CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.mv_raw_to_event_daily_counts
ON CLUSTER '{cluster}'
TO polaris.event_daily_counts
SQL SECURITY NONE
AS
SELECT
    project_id,
    environment,
    event,
    toDate(argMax(occurred_at, _version)) AS occurred_date,
    -- One distinct event_id contributes exactly one to event_count.
    -- The argMax over occurred_at picks the latest revision's date,
    -- so late-arriving corrections that change occurred_at are
    -- handled by SummingMergeTree's merge-time collapse.
    toUInt64(1) AS event_count
FROM polaris.analytics_raw
GROUP BY
    project_id,
    environment,
    event,
    event_id;
