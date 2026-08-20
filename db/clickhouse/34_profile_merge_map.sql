-- Polaris ClickHouse: retroactive profile merges
--
-- When the identity stage discovers that two profiles were one person, it
-- merges them in PostgreSQL and emits `identity.merged`. Every event already
-- written to ClickHouse under the losing profile stays exactly as it was.
--
-- That is the design, not a limitation. History is what we believed at the
-- time we believed it: an event delivered to a vendor under the loser's id
-- really was delivered under that id, and rewriting the row would make the
-- warehouse disagree with the vendor's own record of the same delivery. A
-- rewrite is also a mutation over an arbitrarily large slice of a
-- MergeTree, which on a busy cluster is measured in hours.
--
-- So reads resolve instead. This table maps loser -> winner, a dictionary
-- puts it in memory, and a person-keyed query groups by the CANONICAL id:
--
--   dictGetOrDefault('polaris.profile_canonical', 'winner_profile_id',
--                    (project_id, environment, profile_id), profile_id)
--
-- The `OrDefault` half is the important half: a profile that has never been
-- merged is absent from the dictionary and resolves to itself, so the same
-- expression is correct for every row and no query needs to know whether a
-- merge happened.
--
-- Chains resolve transitively at WRITE time, not read time. If A merges
-- into B and later B merges into C, the worker rewrites A's row to point at
-- C rather than leaving readers to follow two hops — a dictionary lookup
-- cannot iterate, and a query that resolved only one hop would silently
-- under-merge. See `async/merges/merge-worker/v1`.

CREATE TABLE IF NOT EXISTS polaris.profile_merge_map
(
    `project_id`        LowCardinality(String),
    `environment`       LowCardinality(String),
    -- The tombstoned profile. Never resolved to again; retained for lineage.
    `loser_profile_id`  UUID,
    -- The surviving profile, after transitive resolution.
    `winner_profile_id` UUID,
    -- UUIDv7 of the `profile_merges` audit row in PostgreSQL. The join key
    -- back to why this merge happened.
    `merge_id`          UUID,
    `reason`            String,
    `merged_at`         DateTime64(3, 'UTC'),
    -- Highest wins on collapse. A later merge of the same loser — the
    -- transitive rewrite above — must beat the earlier one, and merge time
    -- is the only ordering both the worker and a replay agree on.
    `_version`          UInt64
)
ENGINE = {replicated}ReplacingMergeTree(_version)
ORDER BY (project_id, environment, loser_profile_id)
SETTINGS index_granularity = 8192;

-- The dictionary. LAYOUT(COMPLEX_KEY_HASHED) because the key is a tuple:
-- a profile id is only unique within (project, environment), and a flat
-- layout would let one project's merge resolve another project's profile.
--
-- LIFETIME(MIN 30 MAX 60): the refresh window is the lag between a merge
-- landing and person-keyed queries reflecting it. Seconds, deliberately —
-- a merge is an operator- or resolver-visible event and an analyst who
-- re-runs a query after one is entitled to see it. The cost is a reload of
-- a table that holds one row per merge ever performed, which is small by
-- construction: profiles merge far less often than they are created.
--
-- The source reads the ReplacingMergeTree with FINAL. Without it a loser
-- rewritten by a transitive merge would load both versions and the
-- dictionary would take whichever row it saw last — nondeterministic, and
-- wrong roughly half the time it mattered.
CREATE DICTIONARY IF NOT EXISTS polaris.profile_canonical
(
    `project_id`        String,
    `environment`       String,
    `loser_profile_id`  UUID,
    `winner_profile_id` UUID
)
PRIMARY KEY project_id, environment, loser_profile_id
SOURCE(CLICKHOUSE(
    DB 'polaris'
    QUERY 'SELECT project_id, environment, loser_profile_id, winner_profile_id
           FROM polaris.profile_merge_map FINAL'
))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 30 MAX 60);
