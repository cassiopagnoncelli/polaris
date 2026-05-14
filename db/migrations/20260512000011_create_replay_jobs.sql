-- migrate:up
--
-- Create the `replay_jobs` table.
--
-- A replay job is a durable, operator-issued request to re-process a window
-- of raw events through a specific subsystem (analytics ingest, downstream
-- destination consumers, or a single processor). Replay is a first-class
-- platform capability: every replay is a row here so the audit/lineage trail
-- survives even if the executing worker dies mid-run.
--
-- Replay is BOUNDED to the operational retention window. With v1 defaults
-- that means 90 days for `raw.events`. The CLI rejects job-creation requests
-- whose `from` is older than the window; the schema does NOT encode that
-- bound (it would couple PostgreSQL to the Redpanda retention config) — the
-- CLI is the gate. See:
--
--   - docs/architecture/05-processors-and-replay.md "Replay Window"
--   - docs/architecture/02-control-plane.md "PostgreSQL Owns"
--   - docs/implementation/tasks/P7-001-replay-job-model-cli.md
--
-- Hard architectural rules baked into the schema:
--
--   - PostgreSQL stores replay JOBS (runtime state). PostgreSQL does NOT
--     store replay PLANS (what gets replayed, the windowing rules, the
--     partition strategy). Plans live in versioned code under the planner
--     package shipped by P7-002. There is NO `partition_strategy`,
--     `chunking_rules`, `transform_override`, `field_map`, or any other
--     planner-semantic column here. Adding one in a later task would be a
--     bug; the schema-invariant test in `replay-commands.test.ts` enforces
--     this.
--
--   - `replay_job_id` is the platform-issued public id. Format is
--     `polaris_rpj_<uuidv7>`, mirroring `polaris_dst_<uuidv7>` (destinations)
--     and `polaris_ot_<uuidv7>` (operator tokens). The CHECK pins the prefix.
--
--   - The `(project_id, environment)` FK to `projects(project_id)` keeps the
--     audit trail from dangling when a project is invalid. The CLI rejects a
--     replay creation that points at an unknown project before the INSERT.
--
--   - `status` is the lifecycle of the job, not the lifecycle of the data it
--     replays. The state machine:
--
--         pending  --> planning (P7-002 planner picks the job up)
--         planning --> dry_run  (mode='dry_run')
--         planning --> running  (mode='live')
--         running  --> paused   (operator-issued)
--         paused   --> running  (operator-issued)
--         <any non-terminal> --> cancelled (operator-issued)
--         dry_run / running --> completed | failed (executor-issued)
--
--     This task ships the operator-facing create/cancel/pause/resume surface;
--     the planner-driven transitions land with P7-002 and P7-003. The CLI
--     refuses to advance the state past `pending` because that's not the
--     operator's job; the executor (or the planner dry-run) flips it.
--
--   - `target` is the subsystem that consumes the replayed events:
--       'analytics_raw'  ClickHouse projection rebuild path (P7-005 owns)
--       'destinations'   destination consumers (P7-004 enforces guardrails)
--       'processor'      a single processor (P7-003 enforces version pinning)
--
--   - `mode` is the dispatch mode: `dry_run` plans + counts only, `live`
--     actually emits replay traffic. `dry_run` jobs may transition to
--     `completed` without ever entering `running`.
--
--   - `event_name` / `event_id` scope optional. NULL == "all events in the
--     window for this project+env". Setting `event_id` without `event_name`
--     is allowed (event ids are globally unique) but unusual; the CLI does
--     not refuse the combination.
--
--   - `window_from` / `window_to` are the time window expressed in UTC
--     `timestamptz`. The CLI enforces the 90-day retention bound on
--     `window_from`; the schema enforces that `window_to >= window_from`.
--
--   - `created_by` is the operator label resolved by P6-007's actor
--     resolver. `cli` for unauthenticated invocations; `cli:<email>` for
--     authenticated operator-token sessions. Stored verbatim — the audit
--     row in `audit_records` holds the full actor source / actor label
--     split, so duplicating both columns here would be redundant.
--
--   - `reason` is the operator-supplied rationale. Required by the CLI for
--     every `create`, `cancel`, `pause`, and `resume`. The schema enforces
--     non-empty and a 1024-char cap.
--
--   - `events_planned`, `events_replayed`, `events_failed` are monotonic
--     counters owned by the planner (P7-002) and executor (P7-003). v1
--     starts them at 0; the CLI never writes a non-zero value through this
--     task's commands.
--
-- Indexes:
--
--   - `(status, created_at DESC)` answers "what is in flight right now?" —
--     used by operators triaging a replay queue and by the planner picking
--     up pending jobs.
--
--   - `(project_id, environment, created_at DESC)` answers "what replays did
--     we run for this project?" — the per-project history path.

CREATE TABLE replay_jobs (
  replay_job_id    text        PRIMARY KEY,
  project_id       text        NOT NULL REFERENCES projects(project_id),
  environment      text        NOT NULL,
  -- Optional event-name scope. NULL means "all events in the window".
  event_name       text,
  -- Optional event-id scope. NULL means "all events in the window".
  event_id         text,
  -- Inclusive window bounds. UTC timestamptz on both sides.
  window_from      timestamptz NOT NULL,
  window_to        timestamptz NOT NULL,
  -- Target subsystem for the replay. Closed set; see comment header.
  target           text        NOT NULL,
  -- Dispatch mode. Closed set: dry_run | live.
  mode             text        NOT NULL,
  -- Lifecycle status. Closed set; see comment header for the state machine.
  status           text        NOT NULL DEFAULT 'pending',
  -- Operator label resolved by P6-007 actor resolver.
  created_by       text        NOT NULL,
  -- Operator-supplied rationale (free text, required).
  reason           text        NOT NULL,
  -- Lifecycle timestamps. All UTC timestamptz.
  created_at       timestamptz NOT NULL DEFAULT now(),
  planned_at       timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  -- Monotonic counters owned by planner + executor. Default 0.
  events_planned   bigint      NOT NULL DEFAULT 0,
  events_replayed  bigint      NOT NULL DEFAULT 0,
  events_failed    bigint      NOT NULL DEFAULT 0,

  CONSTRAINT replay_jobs_replay_job_id_format
    CHECK (replay_job_id ~ '^polaris_rpj_[A-Za-z0-9._-]+$'),
  CONSTRAINT replay_jobs_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT replay_jobs_target_allowed
    CHECK (target IN ('analytics_raw', 'destinations', 'processor')),
  CONSTRAINT replay_jobs_mode_allowed
    CHECK (mode IN ('dry_run', 'live')),
  CONSTRAINT replay_jobs_status_allowed
    CHECK (status IN (
      'pending', 'planning', 'dry_run', 'running',
      'paused', 'completed', 'failed', 'cancelled'
    )),
  CONSTRAINT replay_jobs_event_name_length
    CHECK (event_name IS NULL OR (length(event_name) >= 1 AND length(event_name) <= 256)),
  CONSTRAINT replay_jobs_event_id_length
    CHECK (event_id IS NULL OR (length(event_id) >= 1 AND length(event_id) <= 256)),
  CONSTRAINT replay_jobs_created_by_length
    CHECK (length(created_by) >= 1 AND length(created_by) <= 256),
  CONSTRAINT replay_jobs_reason_length
    CHECK (length(reason) >= 1 AND length(reason) <= 1024),
  CONSTRAINT replay_jobs_window_to_after_from
    CHECK (window_to >= window_from),
  CONSTRAINT replay_jobs_planned_after_created
    CHECK (planned_at IS NULL OR planned_at >= created_at),
  CONSTRAINT replay_jobs_started_after_created
    CHECK (started_at IS NULL OR started_at >= created_at),
  CONSTRAINT replay_jobs_finished_after_started
    CHECK (
      finished_at IS NULL
      OR (started_at IS NOT NULL AND finished_at >= started_at)
      OR (started_at IS NULL AND finished_at >= created_at)
    ),
  CONSTRAINT replay_jobs_event_counters_non_negative
    CHECK (events_planned >= 0 AND events_replayed >= 0 AND events_failed >= 0)
);

-- "What's in flight?" — operator triage + planner pickup query.
CREATE INDEX replay_jobs_status_created_idx
  ON replay_jobs (status, created_at DESC);

-- "What replays did we run for this project / environment?" — per-project
-- history path used by `polaris replay list --project --env`.
CREATE INDEX replay_jobs_project_env_created_idx
  ON replay_jobs (project_id, environment, created_at DESC);

-- migrate:down

DROP INDEX IF EXISTS replay_jobs_status_created_idx;
DROP INDEX IF EXISTS replay_jobs_project_env_created_idx;
DROP TABLE IF EXISTS replay_jobs;
