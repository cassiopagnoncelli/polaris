-- Journey participation state.
--
-- Where a profile is in a journey graph right now. The graph itself is
-- code in `catalog/journeys/`, versioned with the repository; only this is
-- runtime state. Same split as audiences: the definition is deploy-time,
-- the membership is not.
--
-- ## One participation per (journey, profile), enforced
--
-- Entry is idempotent because the unique index makes a second entry
-- impossible, not because the orchestrator remembers to check. A trigger
-- that fires twice for one profile -- a redelivered event, two partitions
-- carrying the same audience transition, a replay -- must admit them once.
-- The alternative is a customer walking the same welcome series twice
-- concurrently, which is the failure that reaches them before it reaches a
-- dashboard.
--
-- The index is partial, on `exited_at IS NULL`. A completed participation
-- stays as history, and a re-entry (`reentry: always`, or `after_days`)
-- inserts a new row alongside it -- so the key constrains ACTIVE
-- participation while the trail of past ones survives.
--
-- ## journey_version is recorded and never revised
--
-- A participant walks the graph it entered on. Migrating live participants
-- onto a new version has no correct answer: a profile parked in a 3-day
-- wait that the new graph removed is either dropped mid-journey or
-- teleported to a step it never qualified for. Recording the version here
-- is what makes "which graph did this person actually take" answerable
-- after the definition has moved on.
--
-- ## wait_until is the whole scheduler
--
-- No new scheduling technology. A participant parked on a wait step has a
-- timestamp; `polaris journeys sweep` on a crontab selects the rows whose
-- time has come and advances them. The index below is what makes that
-- select cheap, and it is partial for the same reason the uniqueness one
-- is: only active participants can be waiting.
--
-- @see catalog/journeys/types.ts
-- @see async/journeys/orchestrator/v1/

-- migrate:up

CREATE TABLE journey_participants (
  id                text        PRIMARY KEY,

  project_id        text        NOT NULL REFERENCES projects (project_id),
  environment       text        NOT NULL,

  journey           text        NOT NULL,
  -- The graph this participant walks to completion. Never revised.
  journey_version   integer     NOT NULL,

  profile_id        uuid        NOT NULL,

  -- Where they are now. Always a step id from the entry version's graph.
  step_id           text        NOT NULL,

  -- Set when parked on a wait step, NULL otherwise. The sweep's whole
  -- input: no queue, no timer service, one indexed timestamp column.
  wait_until        timestamptz,

  entered_at        timestamptz NOT NULL DEFAULT now(),
  exited_at         timestamptz,
  -- Closed set, mirroring JOURNEY_EXIT_REASONS in shared-schemas. A funnel
  -- projection groups by this; free text would make it unqueryable within
  -- a month.
  exit_reason       text,

  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT journey_participants_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),

  CONSTRAINT journey_participants_version_positive
    CHECK (journey_version >= 1),

  -- An exit has a reason and a reason implies an exit. Half-set state here
  -- would make "did this participation end?" answerable two ways.
  CONSTRAINT journey_participants_exit_is_complete
    CHECK ((exited_at IS NULL) = (exit_reason IS NULL)),

  CONSTRAINT journey_participants_exit_reason_allowed
    CHECK (exit_reason IS NULL OR exit_reason IN (
      'completed', 'exit_step', 'merged_away', 'definition_retired'
    )),

  -- An exited participant is not waiting for anything.
  CONSTRAINT journey_participants_exited_not_waiting
    CHECK (exited_at IS NULL OR wait_until IS NULL)
);

-- Entry idempotency. See the header: this is what makes a redelivered
-- trigger admit a profile once rather than twice.
CREATE UNIQUE INDEX journey_participants_active_unique_idx
  ON journey_participants (project_id, environment, journey, profile_id)
  WHERE exited_at IS NULL;

-- The sweep's index. Partial and ordered so `wait_until <= now()` reads
-- the head of the index rather than scanning participants who are not
-- waiting -- which, in a healthy system, is nearly all of them.
CREATE INDEX journey_participants_due_idx
  ON journey_participants (wait_until)
  WHERE exited_at IS NULL AND wait_until IS NOT NULL;

-- Merge handling reads by profile: when a profile loses a merge, its
-- active participations are exited `merged_away`.
CREATE INDEX journey_participants_profile_idx
  ON journey_participants (project_id, environment, profile_id)
  WHERE exited_at IS NULL;

COMMENT ON TABLE journey_participants IS
  'Where a profile is in a journey graph. Definitions are code in catalog/journeys/; only this is runtime state.';
COMMENT ON COLUMN journey_participants.journey_version IS
  'Graph version this participant walks to completion. Never revised -- see the migration header.';
COMMENT ON COLUMN journey_participants.wait_until IS
  'Set while parked on a wait step. The only input polaris journeys sweep needs.';

-- migrate:down

DROP TABLE journey_participants;
