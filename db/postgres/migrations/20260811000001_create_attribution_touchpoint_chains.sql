-- migrate:up
--
-- ADR 0005: Create the `attribution_touchpoint_chains` table.
--
-- The attribution engine tracks, per identifier, the first campaign
-- touchpoint ever observed and the most recent one. Until this migration
-- that state lived in a process-local `Map` with, in the store module's
-- own words, no TTL and no LRU bound: chains persisted "for the lifetime
-- of the process". That is two defects wearing one coat — an unbounded
-- map in a long-running service, and state whose loss silently changes
-- attribution results rather than costing a bounded window.
--
-- ## Why PostgreSQL and not Redis
--
-- The sessionizer's state moved to Redis in the same ADR, and the split
-- is deliberate. Session records are TTL-shaped: they must die at the
-- inactivity window, so Redis expiry *is* the domain rule. Touchpoint
-- chains have no natural expiry — attribution windows run 30 to 90 days,
-- so a Redis TTL would mean holding an unbounded hot keyspace for
-- months. PostgreSQL gives bounds, durability and queryability together,
-- reuses the repository pattern `identity_links` already established,
-- and makes chains inspectable, which operators cannot do today at all.
--
-- ## Shape
--
-- One row per (project_id, environment, primary_identifier_kind,
-- primary_identifier_value) — the same key the in-memory store built
-- through `buildTouchpointStoreKey`, decomposed into columns so the
-- table is queryable by identifier rather than by an opaque string.
--
-- The first-touch columns are write-once by convention: the runtime
-- never rewrites them once a chain exists, because first-touch
-- attribution is by definition anchored to the first observation. The
-- last-touch columns are updated on every campaign delta. There is no
-- constraint enforcing that (it would need a trigger), but the
-- repository's UPDATE never names the first_* columns, which is the
-- enforcement that actually holds.
--
-- Campaign tuples are stored as JSONB rather than six columns each: they
-- are read and written whole, never filtered by component, and a tuple
-- gaining a field (a new click-id vendor) would otherwise be a
-- migration. `NOT NULL DEFAULT '{}'::jsonb` keeps them non-null so
-- readers never branch on absence.

CREATE TABLE IF NOT EXISTS attribution_touchpoint_chains (
    project_id                TEXT        NOT NULL,
    environment               TEXT        NOT NULL,
    primary_identifier_kind   TEXT        NOT NULL,
    primary_identifier_value  TEXT        NOT NULL,

    -- First touch: anchored at chain creation, never rewritten.
    first_touchpoint_id       TEXT        NOT NULL,
    first_touchpoint_tuple    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    first_source_event_id     TEXT        NOT NULL,
    first_observed_at         TIMESTAMPTZ NOT NULL,

    -- Last touch: rewritten on every campaign delta.
    last_touchpoint_id        TEXT        NOT NULL,
    last_touchpoint_tuple     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    last_source_event_id      TEXT        NOT NULL,
    last_observed_at          TIMESTAMPTZ NOT NULL,

    -- Total observations, including same-tuple repeats.
    touchpoint_count          BIGINT      NOT NULL DEFAULT 0,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT attribution_touchpoint_chains_pkey
        PRIMARY KEY (project_id, environment, primary_identifier_kind, primary_identifier_value)
);

-- The hot path is a point lookup on the primary key, which the PK index
-- already serves. This index serves the other access pattern the table
-- newly enables: "what has this project attributed recently", for
-- operators debugging an attribution result.
CREATE INDEX IF NOT EXISTS attribution_touchpoint_chains_recent_idx
    ON attribution_touchpoint_chains (project_id, environment, last_observed_at DESC);

-- migrate:down

DROP INDEX IF EXISTS attribution_touchpoint_chains_recent_idx;
DROP TABLE IF EXISTS attribution_touchpoint_chains;
