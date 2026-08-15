-- Polaris ClickHouse: current profile state
--
-- One row per person, holding the traits Polaris currently believes.
-- Fed from `profile_events_queue` by 37_mv_profile_events_to_profiles.sql.
--
-- ## Version is traits_version, not a timestamp
--
-- `ReplacingMergeTree(traits_version)` rather than `(_version)`, and the
-- difference matters. `traits_version` is minted by the profile store, in
-- the same UPDATE that writes the traits, and it increments once per
-- profile per change regardless of which writer made it. A timestamp would
-- let two writers on clocks a second apart collapse in the wrong order and
-- resurrect a trait the other had just removed.
--
-- It also means a redelivered `profile.updated` collapses against its own
-- earlier copy instead of accumulating: same version, same row.
--
-- ## Traits are the FULL map here, not the changed keys
--
-- The stream carries changed keys only — a full snapshot per update would
-- multiply storage by the trait count. This table carries the whole map,
-- because it answers "what is true of this person now" and a reader should
-- not have to fold a stream to find out.
--
-- The MV does that fold. See its file for why that is a `SimpleAggregateFunction`
-- rather than an application-side merge.
--
-- ## Retention
--
-- No TTL. This is current state, not history: a row is one person, it is
-- replaced rather than appended, and the table's size is bounded by the
-- number of people rather than by time. History lives in
-- `analytics_processed` via the event stream and carries its own TTL.

CREATE TABLE IF NOT EXISTS polaris.profiles ON CLUSTER '{cluster}'
(
    `project_id`     LowCardinality(String),
    `environment`    LowCardinality(String),
    `profile_id`     UUID,
    -- The whole current map, folded from the changed-key stream by the MV.
    `traits`         Map(String, String),
    -- Monotonic per profile, minted by the profile store. See above.
    `traits_version` UInt64,
    `updated_at`     DateTime64(3, 'UTC')
)
ENGINE = {replicated}ReplacingMergeTree(traits_version)
ORDER BY (project_id, environment, profile_id)
SETTINGS index_granularity = 8192;
