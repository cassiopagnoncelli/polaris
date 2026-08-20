-- Polaris ClickHouse: rebuild SELECT for session_daily_metrics.
--
-- Wrapped by `polaris clickhouse-rebuild create` (without --dry-run)
-- as the right-hand side of:
--
--   INSERT INTO polaris.session_daily_metrics
--   <this select>
--
-- The body mirrors the SELECT inside the live MV
-- (materialized-views/43_mv_processed_to_session_daily_metrics.sql) so a
-- rebuild produces the same output the MV would emit if it had read the
-- source partition fresh. The partition is bound via the ClickHouse
-- query-params mechanism so the rebuild SQL stays parameter-safe — no
-- string interpolation of the partition label.
--
-- Source is analytics_processed, not analytics_raw. The rebuild driver
-- takes the source table from this file, so nothing else in the rebuild
-- machinery needs to know the difference.
--
-- Partition alignment caveat, identical in shape to event_daily_counts:
-- `analytics_processed` is partitioned by `toYYYYMM(occurred_at)` and
-- `session_daily_metrics` by `toYYYYMM(occurred_date)` where
-- `occurred_date = toDate(argMax(occurred_at, _version))`. Filtering the
-- source on its own partition is correct except for revisions that move
-- occurred_at across a month boundary — captured as a known gap on the
-- plan.
SELECT
    project_id,
    environment,
    toDate(argMax(occurred_at, _version)) AS occurred_date,
    toUInt64(event = 'session.started') AS sessions_started,
    toUInt64(event = 'session.ended')   AS sessions_ended
FROM polaris.analytics_processed
WHERE _partition_id = {partition:String}
  AND event IN ('session.started', 'session.ended')
GROUP BY
    project_id,
    environment,
    event,
    event_id;
