-- Polaris ClickHouse: argMax-based MV that feeds event_daily_counts.
--
-- Reads insert blocks landing in polaris.analytics_raw and emits
-- per-day event counts into the projection table. Deduped WITHIN an insert
-- block only — see the note below.
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
-- IMPORTANT — these counters are APPROXIMATE, and upward-biased.
--
-- A materialized view sees only the rows of the INSERT it is attached to.
-- The GROUP BY below therefore collapses duplicates that arrive in the SAME
-- block, and nothing else. A duplicate arriving in a LATER block — which is
-- what every redelivery, rewind and crash-replay produces, by construction —
-- forms its own group and emits another +1.
--
-- SummingMergeTree then SUMS those rows, because `event_id` is not part of
-- the projection's ORDER BY: it was aggregated away here. Summing two +1s for
-- one logical event gives 2. It cannot do otherwise; it has no way to know
-- the two rows describe the same event.
--
-- The base table's ReplacingMergeTree collapse does NOT propagate here
-- either: an MV fires on insert, not on merge.
--
-- So this projection over-counts by exactly the number of cross-block
-- duplicates, and the platform is at-least-once by design. The exact figure
-- comes from the rebuild path (projections/*_rebuild.sql), which re-derives
-- the projection from a full partition scan in one pass and therefore sees
-- every duplicate at once.
--
-- An earlier version of this comment asserted the opposite, and described the
-- summing mechanism in its own next breath without noticing the two could not
-- both be true. It survived review because a comment in that register reads
-- like an audit that already happened.

-- SQL SECURITY NONE: the MV's SELECT is not privilege-checked.
--
-- A materialized view without this clause runs its SELECT as the user
-- performing the INSERT. That user is `polaris_sink`, which holds INSERT
-- on the ingestion interface table and — deliberately, per
-- db/clickhouse/roles/01_grants.sql — SELECT on nothing at all. So every
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
    -- One distinct event_id contributes exactly one PER INSERT BLOCK.
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
