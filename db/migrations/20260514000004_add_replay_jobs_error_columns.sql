-- migrate:up
--
-- Persist executor error state on `replay_jobs`.
--
-- Background:
--
--   P7-001 created `replay_jobs` with the operator-facing lifecycle
--   (`pending|planning|dry_run|running|paused|completed|failed|cancelled`)
--   and the planner / executor counters (`events_planned`,
--   `events_replayed`, `events_failed`). It did NOT carry an error
--   surface — `status='failed'` could only point at a row with no
--   stored cause, so operators had to dig through worker logs to triage.
--
--   P7-003 ships the processor replay executor. When a chunk's
--   producer.publish raises and we cannot retry, the executor marks the
--   row `failed`. This migration adds the two columns the executor
--   needs to persist the cause:
--
--     - `error_class`   text, the error's runtime class name (e.g.
--                       `KafkaJSConnectionError`, `Error`). Capped at
--                       128 chars to fit any reasonable class name.
--
--     - `error_message` text, the human-readable message. Capped at
--                       4096 chars. The CLI's `polaris replay show`
--                       displays this directly so operators see the
--                       cause inline with the row.
--
-- Hard architectural rules baked into the migration:
--
--   - **Only valid when status='failed'.** A CHECK constraint enforces
--     `error_class IS NULL` UNLESS `status='failed'`. The executor's
--     `markFailed` writer is the only code path that stamps these
--     columns; the schema refuses to record an error on a non-failed
--     row.
--
--   - **`error_class` and `error_message` move together.** A second
--     CHECK ties them to each other so a row cannot carry a class
--     without a message or vice versa. Either both are NULL or both
--     are NOT NULL.
--
--   - **No `audit_records.action` slot.** Replay failure is an
--     executor-internal event, not an operator-issued mutation; the
--     audit trail for replay state changes lives in `audit_records`
--     under `replay.create`, `replay.cancel`, etc. (P7-001). The
--     executor's lifecycle transitions (running -> completed | failed)
--     are not separately audited — they are operationally derivable
--     from the row's timestamps + counters.
--
-- @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
-- @see docs/implementation/tasks/P7-003-processor-replay-executor.md
-- @see db/migrations/20260512000011_create_replay_jobs.sql

ALTER TABLE replay_jobs
  ADD COLUMN error_class   text,
  ADD COLUMN error_message text;

ALTER TABLE replay_jobs
  ADD CONSTRAINT replay_jobs_error_class_length
    CHECK (
      error_class IS NULL
      OR (length(error_class) >= 1 AND length(error_class) <= 128)
    );

ALTER TABLE replay_jobs
  ADD CONSTRAINT replay_jobs_error_message_length
    CHECK (
      error_message IS NULL
      OR (length(error_message) >= 1 AND length(error_message) <= 4096)
    );

-- error_class and error_message must move together: either both NULL or
-- both NOT NULL. A partial stamp is a bug.
ALTER TABLE replay_jobs
  ADD CONSTRAINT replay_jobs_error_columns_together
    CHECK (
      (error_class IS NULL AND error_message IS NULL)
      OR (error_class IS NOT NULL AND error_message IS NOT NULL)
    );

-- Error columns are only valid when the row is in the failed state. A
-- successful or in-flight row cannot carry an error_class.
ALTER TABLE replay_jobs
  ADD CONSTRAINT replay_jobs_error_only_when_failed
    CHECK (
      error_class IS NULL
      OR status = 'failed'
    );

-- migrate:down

ALTER TABLE replay_jobs
  DROP CONSTRAINT IF EXISTS replay_jobs_error_only_when_failed;

ALTER TABLE replay_jobs
  DROP CONSTRAINT IF EXISTS replay_jobs_error_columns_together;

ALTER TABLE replay_jobs
  DROP CONSTRAINT IF EXISTS replay_jobs_error_message_length;

ALTER TABLE replay_jobs
  DROP CONSTRAINT IF EXISTS replay_jobs_error_class_length;

ALTER TABLE replay_jobs
  DROP COLUMN IF EXISTS error_message,
  DROP COLUMN IF EXISTS error_class;
