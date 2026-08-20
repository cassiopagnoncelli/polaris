-- migrate:up
--
-- Create the `processor_runs` table.
--
-- Every processor execution is tracked as a row here. Per
-- `docs/architecture/05-processors-and-replay.md` "Processors and Replay",
-- processors are independent, versioned TypeScript services and Polaris
-- records runs in PostgreSQL so:
--
--   - replay tooling (P7) can target exact processor versions and join
--     emitted events against their producing run,
--   - the control plane can show "what's running" for a processor in a
--     given (project, environment) without scraping Kafka,
--   - operators can correlate incidents to specific runs by `run_id`
--     (UUIDv7, time-ordered).
--
-- This table is the runtime/control-plane counterpart of
-- `processor_activations`: activations decide whether a processor SHOULD be
-- running for a `(name, version, project, environment)` tuple; runs record
-- the actual instances that DID run. The two tables join on
-- `(processor_name, processor_version, project_id, environment)`.
--
-- Hard architectural rules baked into the schema:
--
--   - PostgreSQL does NOT store processor transform rules. The semantic
--     definition of every processor (inputs, outputs, mode, transform code)
--     lives in `processors/<name>/v<n>/processor.manifest.yaml` and the
--     adjacent TypeScript. This table records only RUNTIME state: which run
--     happened, when, with what outcome and counters. NO column resembling
--     `transform`, `rule`, `mapping`, `input_topic`, `output_topic`,
--     `config_blob`, `routing`, or `enrichment`.
--
--   - The Kafka committed offset remains the authoritative checkpoint for
--     resumption. `last_offset` here is INFORMATIONAL — it lets operators
--     see the latest position the run observed without consulting the
--     broker, but the runtime never reads from this column to decide where
--     to resume.
--
--   - `error_summary` is a SHORT human-readable note (truncated at the
--     application layer). Full stack traces belong in logs (Loki), not in
--     this column.
--
-- Anchored to the architecture docs:
--   - docs/architecture/05-processors-and-replay.md "Processors and Replay"
--   - docs/architecture/02-control-plane.md "PostgreSQL Owns"
--   - docs/implementation/tasks/P8-001-processor-runtime-helpers.md

CREATE TABLE processor_runs (
  run_id              text        PRIMARY KEY,
  processor_name      text        NOT NULL,
  processor_version   text        NOT NULL,
  -- Optional (project, environment) scope. Some processors run cross-project
  -- (e.g. analytics-projector); they leave these columns NULL.
  project_id          text        REFERENCES projects(project_id),
  environment         text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  status              text        NOT NULL DEFAULT 'running',
  events_consumed     integer     NOT NULL DEFAULT 0,
  events_emitted      integer     NOT NULL DEFAULT 0,
  events_failed       integer     NOT NULL DEFAULT 0,
  -- Informational checkpoint: the latest Redpanda offset the run observed.
  -- The Kafka consumer group offset remains the authoritative resume point.
  last_offset         bigint,
  -- Pod / hostname stamped at run registration. Optional because
  -- processors may run outside a managed scheduler (e.g. local dev).
  host                text,
  -- Short failure note. Long stack traces belong in logs.
  error_summary       text,

  -- run_id is platform-generated; the application allocates a UUIDv7
  -- but the column is `text` so the v1 issuer is not pinned to the
  -- `uuid` type (Polaris does not use pgcrypto / uuid-ossp; see
  -- `db/migrations/20260512000001_bootstrap.sql`).
  CONSTRAINT processor_runs_run_id_nonempty
    CHECK (length(run_id) >= 1 AND length(run_id) <= 64),
  CONSTRAINT processor_runs_processor_name_format
    CHECK (processor_name ~ '^[a-z][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT processor_runs_processor_version_format
    CHECK (processor_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT processor_runs_status_allowed
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT processor_runs_environment_allowed
    CHECK (environment IS NULL OR environment IN ('development', 'staging', 'production')),
  CONSTRAINT processor_runs_event_counters_non_negative
    CHECK (events_consumed >= 0 AND events_emitted >= 0 AND events_failed >= 0),
  CONSTRAINT processor_runs_finished_after_started
    CHECK (finished_at IS NULL OR finished_at >= started_at),
  -- A run that has finished must have a terminal status; a row in
  -- `running` must not have `finished_at` set. This guards against
  -- partial writes during a failed transition.
  CONSTRAINT processor_runs_finished_matches_status
    CHECK (
      (status = 'running' AND finished_at IS NULL)
      OR (status IN ('completed', 'failed', 'cancelled') AND finished_at IS NOT NULL)
    ),
  CONSTRAINT processor_runs_error_summary_length
    CHECK (error_summary IS NULL OR length(error_summary) <= 2048)
);

-- Listing path: "show me the recent runs for this processor version"
-- (operator triage, replay-target inspection, dashboards).
CREATE INDEX processor_runs_name_version_started_idx
  ON processor_runs (processor_name, processor_version, started_at DESC);

-- "What's still running?" / "what failed recently?" path.
CREATE INDEX processor_runs_status_started_idx
  ON processor_runs (status, started_at DESC);

-- Scoped lookup for control-plane UI: list runs by (project, environment).
CREATE INDEX processor_runs_project_env_started_idx
  ON processor_runs (project_id, environment, started_at DESC);

-- migrate:down

DROP TABLE processor_runs;
