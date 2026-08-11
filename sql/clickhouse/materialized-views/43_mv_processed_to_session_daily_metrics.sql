-- Polaris ClickHouse: argMax-based MV that feeds session_daily_metrics.
--
-- Reads insert blocks landing in polaris.analytics_processed and emits
-- already-deduped per-day session counts into the projection table.
--
-- Same dedupe pattern as 41_mv_raw_to_event_daily_counts.sql
-- (docs/architecture/07-clickhouse.md "Query Patterns / Pattern 1"):
--
--   GROUP BY (project_id, environment, event, event_id)
--   argMax(<col>, _version)
--
-- The WHERE is a projection filter, not a routing filter. Routing —
-- source events vs derived events — is settled by clickhouse-sink at
-- INSERT time. This clause exists because analytics_processed holds all
-- four derived families and this projection is about two event names in
-- one of them.
--
-- `event` stays in the GROUP BY because it is part of the dedupe key, but
-- it is read directly rather than through argMax: it is constant within
-- each group by construction.

-- SQL SECURITY NONE: the MV's SELECT is not privilege-checked.
--
-- Same reasoning as every other Polaris MV. Without it the SELECT runs as
-- the inserting user — `polaris_sink`, which holds INSERT and no SELECT
-- anywhere — so every insert fails with ACCESS_DENIED "while pushing to
-- view", and because the sink rolls its checkpoint back on a failed
-- batch, nothing ever reaches ClickHouse.
CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.mv_processed_to_session_daily_metrics
ON CLUSTER '{cluster}'
TO polaris.session_daily_metrics
SQL SECURITY NONE
AS
SELECT
    project_id,
    environment,
    toDate(argMax(occurred_at, _version)) AS occurred_date,
    -- One distinct event_id contributes exactly one to one counter.
    toUInt64(event = 'session.started') AS sessions_started,
    toUInt64(event = 'session.ended')   AS sessions_ended
FROM polaris.analytics_processed
WHERE event IN ('session.started', 'session.ended')
GROUP BY
    project_id,
    environment,
    event,
    event_id;
