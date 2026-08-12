-- migrate:up
--
-- Scope `attribution_touchpoint_chains` rows to the processor version
-- that wrote them.
--
-- ## Why
--
-- `processor_activations` is keyed by (processor_name, processor_version,
-- project_id, environment), so nothing stops attribution-engine v1 and v2
-- being enabled for the same project at the same time — during a cutover,
-- that is the normal state rather than a mistake. Sharing one chain row
-- between them would corrupt both: v2 expires a chain after an inactivity
-- gap and v1 never does, so each would keep resurrecting or overwriting
-- state the other had decided about, and the resulting first-touch
-- assignments would depend on delivery interleaving.
--
-- Adding the version to the key makes the two sets of chains disjoint.
-- Each version reads and writes only its own rows, a cutover is a matter
-- of enabling one and disabling the other, and a v1 replay running
-- alongside live v2 traffic cannot disturb it.
--
-- ## Migration safety
--
-- The table shipped one day before this migration and carries no
-- production data yet, so the PK swap needs no backfill window. The
-- DEFAULT 'v1' is nevertheless correct for any row that does exist: v1
-- was the only writer.
--
-- The default stays on the column deliberately. It is not there for
-- convenience — it is what lets v1's repository keep issuing inserts that
-- do not name the column, which is the property that makes this a
-- non-semantic change to a released processor version.

ALTER TABLE attribution_touchpoint_chains
    ADD COLUMN IF NOT EXISTS processor_version TEXT NOT NULL DEFAULT 'v1';

ALTER TABLE attribution_touchpoint_chains
    DROP CONSTRAINT IF EXISTS attribution_touchpoint_chains_pkey;

ALTER TABLE attribution_touchpoint_chains
    ADD CONSTRAINT attribution_touchpoint_chains_pkey
    PRIMARY KEY (processor_version, project_id, environment,
                 primary_identifier_kind, primary_identifier_value);

-- The operator-facing "what has this project attributed recently" index
-- gains the version for the same reason the key did: during a cutover the
-- unversioned answer is two interleaved answers.
DROP INDEX IF EXISTS attribution_touchpoint_chains_recent_idx;
CREATE INDEX IF NOT EXISTS attribution_touchpoint_chains_recent_idx
    ON attribution_touchpoint_chains
       (processor_version, project_id, environment, last_observed_at DESC);

-- migrate:down

DROP INDEX IF EXISTS attribution_touchpoint_chains_recent_idx;

ALTER TABLE attribution_touchpoint_chains
    DROP CONSTRAINT IF EXISTS attribution_touchpoint_chains_pkey;

-- Collapsing the key can leave duplicate (project, environment,
-- identifier) rows if more than one processor version ever wrote. Keep
-- the newest per identifier so the down-migration cannot fail on the PK.
DELETE FROM attribution_touchpoint_chains a
    USING attribution_touchpoint_chains b
    WHERE a.project_id = b.project_id
      AND a.environment = b.environment
      AND a.primary_identifier_kind = b.primary_identifier_kind
      AND a.primary_identifier_value = b.primary_identifier_value
      AND (a.last_observed_at, a.processor_version)
          < (b.last_observed_at, b.processor_version);

ALTER TABLE attribution_touchpoint_chains
    ADD CONSTRAINT attribution_touchpoint_chains_pkey
    PRIMARY KEY (project_id, environment,
                 primary_identifier_kind, primary_identifier_value);

ALTER TABLE attribution_touchpoint_chains
    DROP COLUMN IF EXISTS processor_version;

CREATE INDEX IF NOT EXISTS attribution_touchpoint_chains_recent_idx
    ON attribution_touchpoint_chains (project_id, environment, last_observed_at DESC);
