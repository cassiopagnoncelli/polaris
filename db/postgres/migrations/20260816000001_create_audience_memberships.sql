-- migrate:up
--
-- Create `audience_memberships`: who is currently in which audience.
--
-- Implements `docs/implementation/pipeline-redesign-plan.md` §6 (audiences).
--
-- ---------------------------------------------------------------------
-- Why this is legal under the database-light rule
-- ---------------------------------------------------------------------
--
-- `docs/README.md` rule 7: PostgreSQL stores mutable runtime state, not
-- semantic platform truth. What an audience MEANS — the predicate, the
-- traits it reads, the version — is code in `catalog/audiences/` and never
-- appears here. This table holds only the derived answer: which profile
-- the last run found inside the population.
--
-- That split is also the repair mechanism. A wrong audience is fixed by
-- correcting the definition and re-running, not by UPDATEing rows: the
-- runner diffs desired against stored and emits the transitions that
-- correction implies. These rows are a cache of a computation, and the
-- definition is the source of truth.
--
-- Structural prohibitions, same convention as `profiles` and
-- `destinations`: no `predicate`, `rule`, `expression`, `mapping`,
-- `transform` or `config_blob` column appears here or may be added. A
-- predicate in this table would make the audience's meaning editable
-- without a deploy, which is the whole thing the file-heavy rule forbids.
--
-- ---------------------------------------------------------------------
-- Shape decisions
-- ---------------------------------------------------------------------
--
--   - One row per `(project, environment, audience, profile)` — NOT per
--     transition. Membership history lives on the spine as
--     `audience.entered` / `audience.exited` events, the same division
--     `profiles.traits` and `profile.updated` already use: current state
--     in Postgres because it is read on a schedule, history in ClickHouse
--     because it is unbounded and analytical.
--
--   - `exited_at` is nullable and the row SURVIVES an exit. A member who
--     left is a fact worth keeping until the next run: deleting the row
--     would make re-entry indistinguishable from first entry, and
--     `audience.entered` would fire again for someone who never left as
--     far as any downstream vendor could tell. The partial index below
--     keeps the open set cheap to read regardless.
--
--   - `audience_version` records which definition version last EVALUATED
--     the row, not which one the profile joined under. A version bump
--     re-derives membership; a profile that qualifies under both versions
--     stays a member and simply has its stamp updated. The alternative —
--     scoping membership by version — would exit and re-enter the entire
--     population on every predicate tweak, flooding destinations with
--     transitions that describe an edit rather than a person.
--
--   - No FK to a definitions table, because there is no definitions
--     table. `audience` is the catalog key; a row whose key no longer
--     exists in the registry is an orphan the runner reports rather than
--     a constraint the database enforces, since deleting a definition is
--     a deploy and the rows outlive it by design.

CREATE TABLE audience_memberships (
    project_id       text        NOT NULL REFERENCES projects (project_id),
    environment      text        NOT NULL,
    -- Catalog key from `catalog/audiences/`. Stable by contract: renaming
    -- one orphans every row recorded under the old key.
    audience         text        NOT NULL,
    -- Definition version that last evaluated this row. See header.
    audience_version integer     NOT NULL,
    profile_id       uuid        NOT NULL REFERENCES profiles (profile_id),
    entered_at       timestamptz NOT NULL DEFAULT now(),
    -- NULL while the profile is a member. Set when a run finds it no
    -- longer qualifies; cleared again on re-entry.
    exited_at        timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (project_id, environment, audience, profile_id),

    CONSTRAINT audience_memberships_environment_check
        CHECK (environment IN ('development', 'staging', 'production')),
    CONSTRAINT audience_memberships_audience_shape
        CHECK (audience ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT audience_memberships_version_positive
        CHECK (audience_version > 0),
    -- An exit cannot precede the entry it ends.
    CONSTRAINT audience_memberships_exit_after_entry
        CHECK (exited_at IS NULL OR exited_at >= entered_at)
);

-- The runner's hot read: the OPEN membership for one audience in one
-- scope. Partial, because a long-lived audience accumulates exited rows
-- indefinitely and the diff never looks at them.
CREATE INDEX audience_memberships_open_idx
    ON audience_memberships (project_id, environment, audience)
    WHERE exited_at IS NULL;

-- "Which audiences is this profile in?" — the destination-side question,
-- asked per profile rather than per audience.
CREATE INDEX audience_memberships_profile_idx
    ON audience_memberships (project_id, environment, profile_id)
    WHERE exited_at IS NULL;

COMMENT ON TABLE audience_memberships IS
    'Derived audience membership. Definitions live in catalog/audiences/; '
    'transition history lives on profile.events. Rebuildable by re-running '
    'polaris audiences compute.';

-- migrate:down

DROP TABLE audience_memberships;
