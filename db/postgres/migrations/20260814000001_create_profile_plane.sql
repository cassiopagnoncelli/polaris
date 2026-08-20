-- migrate:up
--
-- Create the profile plane: `profiles`, `profile_identifiers`,
-- `profile_merges`.
--
-- This is the store Polaris did not have. Until now the platform recorded
-- that two identifiers were believed to be the same person
-- (`identity_links`) but had nowhere to put the person, which is why that
-- table has exactly one writer and zero readers. These three tables give
-- the resolver a person to find-or-create, and give every downstream stage
-- a `profile_id` to key on.
--
-- Implements `docs/implementation/pipeline-redesign-plan.md` §4.1.
--
-- ---------------------------------------------------------------------
-- Why this is legal under the database-light rule
-- ---------------------------------------------------------------------
--
-- `docs/README.md` rule 7: PostgreSQL stores mutable runtime/control
-- state, not semantic platform truth. Everything here is DERIVED state:
-- every row is reproducible by replaying `raw.events` through a pinned
-- resolver version under a given policy. Nothing here defines what an
-- event means, how it is mapped, or where it routes.
--
-- That is not a technicality — it is the repair mechanism. A bad merge is
-- undone by rebuilding the project's profiles from `raw.events` under a
-- corrected denylist (`polaris profiles rebuild`, R4), not by an inverse
-- operation. These tables are a cache of a computation, and the
-- computation is the source of truth.
--
-- Structural prohibitions, same convention as `destinations` and
-- `processor_activations`: no `mapping`, `field_map`, `event_map`,
-- `transform`, `rule`, `routing`, `partition_strategy` or `config_blob`
-- column appears here or may be added. `traits` is a value bag owned by
-- the project, not platform semantics.
--
-- ---------------------------------------------------------------------
-- Shape decisions
-- ---------------------------------------------------------------------
--
--   - `profile_identifiers` is the RESOLVED graph; `identity_links`
--     survives as the EVIDENCE ledger explaining why. Two tables because
--     they answer different questions: "who is this?" must be one indexed
--     lookup on the hot path, while "why do we believe that?" is an
--     audit-time walk. Collapsing them would put graph traversal in front
--     of every event.
--
--   - The identifier table's PRIMARY KEY is
--     `(project_id, environment, kind, value)`. That is the resolver's
--     entire hot-path read, so the PK index serves it directly — no
--     secondary index needed for lookup, and the constraint is also what
--     makes concurrent find-or-create safe: two workers racing to bind the
--     same identifier resolve to one winner instead of two profiles.
--
--   - `merged_into` is an AUDIT pointer, never a routing hop. Merges
--     repoint every identifier row to the winner inside the same
--     transaction, so a read is always one lookup; chains never form and
--     no reader traverses this column. The loser row survives as a
--     tombstone so historical `profile_id` values stamped into ClickHouse
--     stay explainable after the merge.
--
--   - The graph is project-bounded, like `identity_links`. Cross-project
--     identity is an explicit non-goal (plan §11): the same human in two
--     projects is deliberately two profiles.
--
--   - No traits-history table. `profiles.traits` holds the CURRENT value
--     only, because it is runtime state read on the hot path; the history
--     of what a profile believed and when lives in ClickHouse, fed by
--     `profile.updated` events. Putting history here would grow an
--     unbounded table in front of the spine for an analytical question.

CREATE TABLE profiles (
    profile_id            uuid        PRIMARY KEY,
    project_id            text        NOT NULL REFERENCES projects (project_id),
    environment           text        NOT NULL,
    -- Latest authoritative `customer_id` seen for this person. Denormalised
    -- from `profile_identifiers` because destinations want a stable
    -- external id on every event and should not join to get it.
    canonical_customer_id text,
    -- Project-owned trait bag. Merge-patched by the identity stage from
    -- identify-family events; also written by computed traits (R5) and
    -- reverse ETL (R7). Never interpreted by the platform.
    traits                jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Monotonic revision, bumped on every trait write. Stamped onto the
    -- envelope so a historical delivery stays explainable after the
    -- profile moves on.
    traits_version        bigint      NOT NULL DEFAULT 0,
    -- Set when this profile lost a merge. Audit only — see header.
    merged_into           uuid        REFERENCES profiles (profile_id),
    first_seen_at         timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT profiles_environment_check
        CHECK (environment IN ('development', 'staging', 'production')),
    CONSTRAINT profiles_traits_is_object
        CHECK (jsonb_typeof(traits) = 'object'),
    CONSTRAINT profiles_traits_version_non_negative
        CHECK (traits_version >= 0),
    -- A profile cannot be merged into itself: that would make the audit
    -- pointer a cycle and a rebuild non-terminating.
    CONSTRAINT profiles_merged_into_not_self
        CHECK (merged_into IS NULL OR merged_into <> profile_id)
);

-- Winner-side lookup: "which profiles were merged into this one".
CREATE INDEX profiles_merged_into_idx
    ON profiles (merged_into)
    WHERE merged_into IS NOT NULL;

-- Operator lookup by customer id, and the enrichment stage's fallback
-- when it holds a customer id but not yet a profile id.
CREATE INDEX profiles_canonical_customer_idx
    ON profiles (project_id, environment, canonical_customer_id)
    WHERE canonical_customer_id IS NOT NULL;

CREATE TABLE profile_identifiers (
    project_id    text        NOT NULL,
    environment   text        NOT NULL,
    -- Open vocabulary, deliberately text and not an enum: v1 binds
    -- `customer_id` and `anonymous_id`, and `device_id` / `email` are
    -- reserved for when a producer actually supplies them. A new kind
    -- lands as data plus resolver code, never as a migration.
    kind          text        NOT NULL,
    value         text        NOT NULL,
    profile_id    uuid        NOT NULL REFERENCES profiles (profile_id),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),

    -- The resolver's hot-path read, and the constraint that serialises
    -- concurrent find-or-create on the same identifier.
    PRIMARY KEY (project_id, environment, kind, value),

    CONSTRAINT profile_identifiers_environment_check
        CHECK (environment IN ('development', 'staging', 'production')),
    CONSTRAINT profile_identifiers_kind_shape
        CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT profile_identifiers_value_non_empty
        CHECK (length(value) > 0 AND length(value) <= 512)
);

-- Reverse lookup: every identifier bound to a profile. Serves
-- `polaris profiles show`, and the merge path, which repoints the loser's
-- rows and needs them by profile.
CREATE INDEX profile_identifiers_profile_idx
    ON profile_identifiers (profile_id);

-- Per-kind binding count, which is what the identifier cap is enforced
-- against on the write path.
CREATE INDEX profile_identifiers_profile_kind_idx
    ON profile_identifiers (profile_id, kind);

CREATE TABLE profile_merges (
    merge_id          uuid        PRIMARY KEY,
    project_id        text        NOT NULL REFERENCES projects (project_id),
    environment       text        NOT NULL,
    winner_profile_id uuid        NOT NULL REFERENCES profiles (profile_id),
    -- Deliberately NOT a foreign key with ON DELETE CASCADE: the loser row
    -- is a tombstone that must outlive any cleanup, because ClickHouse
    -- rows stamped with the loser's id are only explainable through here.
    loser_profile_id  uuid        NOT NULL REFERENCES profiles (profile_id),
    -- The event whose identifiers proved the two profiles were one person.
    source_event_id   uuid        NOT NULL,
    -- Open shape per evidence kind, same convention as `identity_links`.
    evidence          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    merged_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT profile_merges_environment_check
        CHECK (environment IN ('development', 'staging', 'production')),
    CONSTRAINT profile_merges_distinct_sides
        CHECK (winner_profile_id <> loser_profile_id),
    CONSTRAINT profile_merges_evidence_is_object
        CHECK (jsonb_typeof(evidence) = 'object')
);

-- The merge worker (R4) streams these in `merged_at` order to maintain the
-- ClickHouse canonical-profile dictionary.
CREATE INDEX profile_merges_scope_time_idx
    ON profile_merges (project_id, environment, merged_at DESC);

-- "What happened to this profile id?" — the lookup behind a rebuild and
-- behind any operator investigating a stamped id that no longer resolves.
CREATE INDEX profile_merges_loser_idx
    ON profile_merges (loser_profile_id);

-- migrate:down

DROP TABLE IF EXISTS profile_merges;
DROP TABLE IF EXISTS profile_identifiers;
DROP TABLE IF EXISTS profiles;
