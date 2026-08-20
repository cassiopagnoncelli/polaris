-- Polaris ClickHouse: rebuild SELECT for profile_event_daily_counts.
--
-- Wrapped by `polaris clickhouse-rebuild create` (without --dry-run) as
-- the right-hand side of:
--
--   INSERT INTO polaris.profile_event_daily_counts
--   <this select>
--
-- The body mirrors the SELECT inside the live MV
-- (materialized-views/45_mv_raw_to_profile_event_daily_counts.sql) so a
-- rebuild produces the same output the MV would emit if it had read the
-- source partition fresh. The partition is bound via the ClickHouse
-- query-params mechanism so the rebuild SQL stays parameter-safe — no
-- string interpolation of the partition label.
--
-- ## Why this is the exact figure and the MV is not
--
-- The MV fires per INSERT block, so one logical event arriving in two
-- blocks contributes twice and SummingMergeTree adds them: `event_id` is
-- aggregated away, so it has no way to know the two rows describe one
-- event. This rebuild scans a whole partition in one pass and therefore
-- sees every duplicate at once, collapsing them in the GROUP BY. That is
-- the same relationship 40_event_daily_counts_rebuild.sql has with its
-- own MV, and the reason a projection without a rebuild counterpart has
-- no repair path at all.
--
-- Partition alignment caveat, identical to the sibling's:
-- `analytics_raw` is partitioned by `toYYYYMM(occurred_at)` and this
-- projection by `toYYYYMM(occurred_date)` where `occurred_date =
-- toDate(argMax(occurred_at, _version))`. Filtering analytics_raw on the
-- source partition is correct except for revisions that move occurred_at
-- across a month boundary — captured as a known gap on the plan.
--
-- The `profile_id != ''` filter matches the MV's: a row for a person
-- nobody can name is a bucket every reader would have to remember to
-- exclude.
SELECT
    project_id,
    environment,
    profile_id,
    argMax(customer_id, _version) AS customer_id,
    event,
    toDate(argMax(occurred_at, _version)) AS occurred_date,
    toUInt64(1) AS event_count
FROM polaris.analytics_raw
WHERE _partition_id = {partition:String}
  AND profile_id != ''
GROUP BY
    project_id,
    environment,
    profile_id,
    event,
    event_id;
