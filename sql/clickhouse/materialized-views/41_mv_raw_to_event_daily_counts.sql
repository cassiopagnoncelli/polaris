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

CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.mv_raw_to_event_daily_counts
ON CLUSTER '{cluster}'
TO polaris.event_daily_counts
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
