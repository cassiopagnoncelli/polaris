-- migrate:up
--
-- Create the `topic_isolations` table.
--
-- Per `docs/architecture/03-redpanda-topics.md` "Topic Isolation Triggers"
-- and "Topic Families": a project moves from the shared canonical topic
-- (`raw.events`, `enriched.events`, ...) to a dedicated topic
-- (`raw.events.<project_id>`) when one of the documented isolation
-- triggers fires (volume share, retention divergence, lag isolation,
-- schema risk, operational quarantine). The move is operational, not
-- structural; producer and consumer code continues to reference the
-- logical topic family and consults the resolver in
-- `packages/shared-kafka/src/topic-family.ts` for the concrete topic.
--
-- This table is the persistent backing store the resolver consults
-- (through an in-memory TTL+LRU cache so the hot path stays cheap). One
-- row per active (family, project, environment) isolation. Rows are
-- never deleted — `deactivated_at` marks the end of an isolation window
-- so an audit query reconstructs the lifecycle.
--
-- Hard architectural rules baked into the schema:
--
--   - **One active isolation per (family, project, environment).** The
--     resolver returns at most one concrete topic for a family lookup;
--     a partial unique index enforces the uniqueness of active rows
--     while letting deactivated rows accumulate as history.
--
--   - **Closed-set environment and topic-family.** Matching the same set
--     used by `audit_records.environment` and the
--     `CANONICAL_TOPIC_FAMILIES` constant in `shared-kafka`.
--     Widening the set requires widening the CHECK in the same change
--     that exports a new constant.
--
--   - **`concrete_topic` shape is `<family>.<project_id>`.** The CLI
--     (`polaris topics isolate`) computes the value through
--     `dedicatedTopicName(family, project_id)`; the CHECK enforces the
--     prefix so a hand-rolled INSERT cannot drift from the resolver's
--     contract.
--
--   - **Audit trail lives in `audit_records`.** This table records what
--     is currently isolated; `audit_records` (P6-006) records who
--     toggled it and why. The CLI writes both in the SAME transaction
--     so isolation state and audit row are always consistent.
--
-- See:
--   - docs/architecture/03-redpanda-topics.md "Topic Isolation Triggers"
--   - docs/architecture/03-redpanda-topics.md "Topic Families"
--   - docs/operations/topic-isolation-cutover.md
--   - docs/implementation/tasks/P11-008-topic-isolation.md

CREATE TABLE topic_isolations (
  -- Platform-issued UUIDv7. The CLI generates this via the same
  -- `uuid.v7()` helper used elsewhere in the control plane.
  id                 text        PRIMARY KEY,

  -- Project this isolation applies to.
  project_id         text        NOT NULL REFERENCES projects(project_id),

  -- Deployment environment the isolation is scoped to. Each environment
  -- carries its own isolation state because the volume / lag / schema
  -- triggers operate per environment.
  environment        text        NOT NULL,

  -- Logical topic family. Must be one of the canonical families
  -- documented in `packages/shared-kafka/src/topics.ts`. The CLI maps
  -- the operator-supplied `--family` flag onto this set before INSERT.
  topic_family       text        NOT NULL,

  -- Concrete dedicated topic name. Always `<topic_family>.<project_id>`;
  -- materialized in the row so a downstream query does not have to
  -- recompute the resolver's contract.
  concrete_topic     text        NOT NULL,

  -- When the operator activated the isolation. Defaults to `now()` so
  -- the CLI does not have to stamp the value when it wraps INSERT in a
  -- transaction with the audit recorder.
  activated_at       timestamptz NOT NULL DEFAULT now(),

  -- When the operator deactivated the isolation. NULL while the
  -- isolation is active; the resolver only considers rows with
  -- `deactivated_at IS NULL`.
  deactivated_at     timestamptz,

  -- Operator-supplied rationale stamped at activation. Mirrors the
  -- `audit_records.reason` column; kept here so a `topic_isolations`
  -- list shows context inline.
  reason             text        NOT NULL,

  -- Free-text actor label captured at activation. Same convention as
  -- `processor_activations.last_changed_by`: the authoritative actor
  -- identity lives in `audit_records`, this column is a convenience
  -- marker for inline list output.
  actor_id           text        NOT NULL,

  -- Insert / update bookkeeping.
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT topic_isolations_id_format
    CHECK (length(id) >= 1 AND length(id) <= 64),
  CONSTRAINT topic_isolations_project_id_format
    CHECK (length(project_id) >= 1 AND length(project_id) <= 128),
  CONSTRAINT topic_isolations_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT topic_isolations_topic_family_allowed
    CHECK (topic_family IN (
      'raw.events',
      'identity.events',
      'enriched.events',
      'attribution.events',
      'analytics.events'
    )),
  CONSTRAINT topic_isolations_concrete_topic_shape
    CHECK (concrete_topic = topic_family || '.' || project_id),
  CONSTRAINT topic_isolations_reason_length
    CHECK (length(reason) >= 1 AND length(reason) <= 1024),
  CONSTRAINT topic_isolations_actor_id_length
    CHECK (length(actor_id) >= 1 AND length(actor_id) <= 128),
  CONSTRAINT topic_isolations_deactivation_consistent
    CHECK (
      deactivated_at IS NULL OR deactivated_at >= activated_at
    )
);

-- Active-isolation lookup: the resolver's hot path. Returns at most one
-- row for a `(family, project_id, environment)` triple thanks to the
-- partial unique index below.
CREATE INDEX topic_isolations_active_lookup_idx
  ON topic_isolations (topic_family, project_id, environment)
  WHERE deactivated_at IS NULL;

-- Enforces "one active isolation per (family, project, environment)".
-- Deactivated rows survive as history; multiple deactivated rows per
-- triple are allowed (an isolation can be activated, deactivated, then
-- re-activated through separate `polaris topics isolate` calls).
CREATE UNIQUE INDEX topic_isolations_one_active_per_triple_idx
  ON topic_isolations (topic_family, project_id, environment)
  WHERE deactivated_at IS NULL;

-- "What is currently isolated for this project?" — used by inline
-- list output and operational dashboards that surface a per-project
-- isolation summary.
CREATE INDEX topic_isolations_project_active_idx
  ON topic_isolations (project_id, environment)
  WHERE deactivated_at IS NULL;

-- Full-history lookups for forensic / audit queries. Includes the
-- deactivated rows so an operator can answer "when was this family
-- isolated for this project in the past?".
CREATE INDEX topic_isolations_history_idx
  ON topic_isolations (project_id, environment, topic_family, activated_at DESC);

-- migrate:down

DROP INDEX IF EXISTS topic_isolations_history_idx;
DROP INDEX IF EXISTS topic_isolations_project_active_idx;
DROP INDEX IF EXISTS topic_isolations_one_active_per_triple_idx;
DROP INDEX IF EXISTS topic_isolations_active_lookup_idx;
DROP TABLE IF EXISTS topic_isolations;
