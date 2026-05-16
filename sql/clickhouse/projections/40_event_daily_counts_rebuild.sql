-- Polaris ClickHouse: rebuild SELECT for event_daily_counts.
--
-- Wrapped by `polaris clickhouse-rebuild create` (without --dry-run)
-- as the right-hand side of:
--
--   INSERT INTO polaris.event_daily_counts
--   <this select>
--
-- The body mirrors the SELECT inside the live MV
-- (materialized-views/41_mv_raw_to_event_daily_counts.sql) so a
-- rebuild produces the same output the MV would emit if it had read
-- the source partition fresh. The partition is bound via the
-- ClickHouse query-params mechanism so the rebuild SQL stays
-- parameter-safe — no string interpolation of the partition label.
--
-- Partition alignment caveat: `analytics_raw` is partitioned by
-- `toYYYYMM(occurred_at)` and `event_daily_counts` is partitioned by
-- `toYYYYMM(occurred_date)` where `occurred_date = toDate(argMax(
-- occurred_at, _version))`. Filtering analytics_raw on the source
-- partition is correct except for revisions that move occurred_at
-- across a month boundary — captured as a known gap on the plan.
SELECT
    project_id,
    environment,
    event,
    toDate(argMax(occurred_at, _version)) AS occurred_date,
    toUInt64(1) AS event_count
FROM polaris.analytics_raw
WHERE _partition_id = {partition:String}
GROUP BY
    project_id,
    environment,
    event,
    event_id;
