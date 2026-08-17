-- Polaris ClickHouse: current profile state
--
-- One row per (person, trait). Fed from `profile_events_queue` by
-- 37_mv_profile_events_to_profiles.sql.
--
-- ## Why per trait, and not one row holding the whole map
--
-- `profile.updated` carries CHANGED KEYS ONLY — a full snapshot per update
-- would multiply storage by the trait count, which is a decision the
-- event's catalog entry already records.
--
-- A table keyed on `(project, environment, profile_id)` holding a
-- `Map(String, String)` cannot absorb that stream. ReplacingMergeTree
-- replaces the WHOLE row on collapse, so an update carrying one changed
-- key would replace a profile's entire map with that single key and
-- silently delete every trait the update did not mention. It would look
-- correct in every test that writes a profile once.
--
-- Keying on the trait makes each key its own row, so an update touches
-- exactly the keys it names and leaves the rest alone. That is what a
-- sparse stream needs, and it is why `trait_key` is in the sort key.
--
-- (This file carried the Map shape until it was applied against a real
-- server. The MV had already moved to per-trait rows, so the two could
-- not both be right: the table's columns and the view's SELECT list did
-- not even match. Nothing caught it because no test applies the DDL.)
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
-- ## Removal is a tombstone, not a delete
--
-- A trait going away is an update carrying it in `removed_keys`, which
-- lands here as `removed = 1`. Readers filter `removed = 0`. A DELETE
-- would be a mutation over an arbitrarily large slice, and it would race
-- the collapse: a tombstone with a higher `traits_version` is exactly how
-- ReplacingMergeTree is supposed to express "this is gone now".
--
-- ## Retention
--
-- No TTL. This is current state, not history: the table's size is bounded
-- by people times traits rather than by time. History lives in
-- `analytics_processed` via the event stream and carries its own TTL.

CREATE TABLE IF NOT EXISTS polaris.profiles ON CLUSTER '{cluster}'
(
    `project_id`     LowCardinality(String),
    `environment`    LowCardinality(String),
    `profile_id`     UUID,
    -- One trait. The sort key includes it, so a changed-keys update
    -- touches only the keys it names.
    `trait_key`      LowCardinality(String),
    -- Raw JSON of the trait's value, as it arrived. Not typed: a trait is
    -- whatever its definition computed, and a column per shape would make
    -- the catalog a migration.
    `value`          String,
    -- Tombstone. See above; readers filter `removed = 0`.
    `removed`        UInt8,
    -- Monotonic per profile, minted by the profile store. See above.
    `traits_version` UInt64,
    `updated_at`     DateTime64(3, 'UTC')
)
ENGINE = {replicated}ReplacingMergeTree(traits_version)
ORDER BY (project_id, environment, profile_id, trait_key)
SETTINGS index_granularity = 8192;
