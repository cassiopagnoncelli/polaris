-- migrate:up
--
-- Create the `clickhouse_rebuild_jobs` table.
--
-- A ClickHouse rebuild job is a durable, operator-issued request to
-- re-derive an analytical projection table (or its feeder materialized
-- view) by re-reading `polaris.analytics_raw` through the argMax dedupe
-- pattern. Rebuilds are first-class platform workflows — every rebuild
-- is a row here so the audit/lineage trail survives even if the
-- executing worker dies mid-run.
--
-- Hand-rolled `ALTER TABLE … DROP PARTITION` and ad-hoc `INSERT INTO …
-- SELECT FROM analytics_raw` are NOT the supported fix path. They
-- corrupt the audit story (no row here), race with the Kafka Engine
-- consumers downstream of `analytics.events`, and produce inconsistent
-- snapshots across replicas. If a projection is wrong, the answer is a
-- rebuild job through `polaris clickhouse-rebuild`. See
-- `docs/development/clickhouse-rebuilds.md` for the full rationale.
--
-- This table mirrors the shape of `replay_jobs` (P7-001) for the
-- ClickHouse projection world. The two tables are intentionally
-- separate: replay jobs ship Kafka traffic (`raw.events`,
-- `analytics.events`, derived topics), rebuild jobs re-derive
-- ClickHouse projections — they share an operational vocabulary
-- (status, requester, reason, audit) but different targets, different
-- runtime systems, and different planners. Forcing them into the same
-- table would couple the two state machines.
--
-- Scope of this migration (P7-005):
--
--   - Schema for the rebuild-job record + indexes.
--   - The CLI surface that writes `dry_run` rows and `pending` rows.
--
-- Deferred to a follow-up:
--
--   - The executor that actually walks partitions, runs the
--     `INSERT … SELECT argMax(…, _version) FROM analytics_raw GROUP BY
--     (project_id, environment, event, event_id)` block, and advances
--     the row through `running` → `completed`.
--
--   The CLI today rejects a non-dry-run `create` with the explicit
--   reason code `clickhouse_rebuild_executor_not_implemented` and exits
--   non-zero so an operator cannot believe a rebuild already happened.
--
-- Hard architectural rules baked into the schema:
--
--   - `clickhouse_rebuild_job_id` is the platform-issued public id.
--     Format is `polaris_chr_<uuidv7>`, mirroring `polaris_rpj_<uuidv7>`
--     (replay jobs), `polaris_dst_<uuidv7>` (destinations), and
--     `polaris_ot_<uuidv7>` (operator tokens). The CHECK pins the
--     prefix.
--
--   - `target_projection` is a closed-set label from
--     `sql/clickhouse/projections/*.sql` (see
--     `packages/shared-clickhouse/src/rebuild/projections.ts`). The
--     migration does not encode the enum at the schema level because
--     adding a new projection (a new file under `sql/clickhouse/`)
--     should not require a Postgres migration. The CLI / planner is
--     the gate; the migration enforces shape and bounded length only.
--
--   - `target_table_qualified` is the `<database>.<table>` form the
--     executor will write to. Always `polaris.<table>` in v1; the
--     CHECK enforces the prefix so a hand-rolled INSERT cannot point
--     at `system.*` or another database. This is the schema-level
--     defence in depth that complements the CLI's projection validator.
--
--   - `source_range_from` / `source_range_to` are nullable timestamps.
--     Both-NULL means "full table" (the rebuild walks every partition
--     containing rows). Both-set means a bounded rebuild window.
--     Mixed (one NULL, one set) is refused at the CHECK level — the
--     planner forbids partial windows because a one-sided range is
--     almost always a typo on the operator's part.
--
--   - `status` is the lifecycle of the rebuild job, not the lifecycle
--     of the data it derives. The state machine:
--
--         pending  --> planning (P7-005-followup planner picks it up)
--         planning --> dry_run  (--dry-run was requested)
--         planning --> running  (live rebuild — DEFERRED in v1)
--         <any non-terminal> --> aborted (operator-issued)
--         running --> completed | failed (executor-issued; DEFERRED)
--
--     This task ships the operator-facing `create` (dry_run + pending)
--     and `abort` surface. The planner-driven `pending → planning →
--     dry_run → completed` transitions are not yet wired; today a
--     dry-run rebuild row lands directly in `dry_run` status because
--     the dry-run planner runs in-process inside `polaris
--     clickhouse-rebuild create --dry-run`.
--
--   - `error_class` / `error_message` mirror the same pattern shipping
--     in `delivery_records` and `dlq_records`: both must be NULL or
--     both NOT NULL, and a non-NULL `error_class` requires `status =
--     'failed'` (and vice versa). The CHECK constraints are
--     `clickhouse_rebuild_jobs_error_pair` and
--     `clickhouse_rebuild_jobs_error_status_consistent`.
--
--   - `rows_estimated` and `partitions_estimated` are nullable
--     planner-output fields surfaced by `--dry-run`. They are
--     informational; the planner emits null when ClickHouse is
--     unreachable so the operator can still inspect a `dry_run` row
--     for the audit trail without a healthy ClickHouse on the runner.
--
--   - `requester_actor_label` is the operator label resolved by
--     P6-007's actor resolver. `cli` for unauthenticated invocations;
--     `cli:<email>` for authenticated operator-token sessions. Stored
--     verbatim — the audit row in `audit_records` holds the full
--     actor-source / actor-label split, so duplicating both columns
--     here would be redundant. Named `requester_actor_label` rather
--     than `requester_id` because the field is a label, not a UUID
--     FK to an `operators` table (the audit recorder owns the
--     actor-id concept).
--
-- Indexes:
--
--   - `(status, created_at DESC)` answers "what rebuilds are in
--     flight?" — operator triage and the future planner pickup query.
--
--   - `(target_projection, created_at DESC)` answers "what rebuilds
--     have we run for this projection?" — per-projection history.
--
-- See:
--   - docs/architecture/07-clickhouse.md "Replay and Rebuild"
--   - docs/architecture/05-processors-and-replay.md "Replay Control Plane"
--   - docs/architecture/02-control-plane.md "PostgreSQL Owns"
--   - docs/development/clickhouse-rebuilds.md
--   - docs/implementation/tasks/P7-005-clickhouse-rebuild-workflows.md

CREATE TABLE clickhouse_rebuild_jobs (
  clickhouse_rebuild_job_id  text        PRIMARY KEY,

  -- Closed-set projection label from sql/clickhouse/projections/. The
  -- CHECK enforces shape (lowercase identifier-style) but not the
  -- closed set — that lives in code (`packages/shared-clickhouse/src/
  -- rebuild/projections.ts`) so adding a projection does not require
  -- a Postgres migration.
  target_projection          text        NOT NULL,

  -- Fully-qualified target table the executor would write to. Always
  -- `polaris.<table>` in v1; the prefix CHECK below enforces this.
  target_table_qualified     text        NOT NULL,

  -- Optional bounded source range. Both NULL means "full table".
  -- Mixed (one NULL, one set) is refused below.
  source_range_from          timestamptz,
  source_range_to            timestamptz,

  -- Operator-supplied rationale. Required for every create.
  reason                     text        NOT NULL,

  -- Operator label resolved by P6-007's actor resolver.
  requester_actor_label      text        NOT NULL,

  -- Lifecycle status. Closed set; see comment header for the state
  -- machine.
  status                     text        NOT NULL DEFAULT 'pending',

  -- Planner output surfaced by --dry-run. NULL when the planner could
  -- not estimate (e.g. ClickHouse unreachable on the runner).
  rows_estimated             bigint,
  partitions_estimated       integer,

  -- Failure classification. Both-NULL or both-NOT-NULL; error_class
  -- non-NULL ↔ status='failed'.
  error_class                text,
  error_message              text,

  -- Lifecycle timestamps. All UTC timestamptz.
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  started_at                 timestamptz,
  completed_at               timestamptz,

  CONSTRAINT clickhouse_rebuild_jobs_id_format
    CHECK (clickhouse_rebuild_job_id ~ '^polaris_chr_[A-Za-z0-9._-]+$'),
  CONSTRAINT clickhouse_rebuild_jobs_target_projection_shape
    CHECK (target_projection ~ '^[a-z][a-z0-9_]{0,127}$'),
  CONSTRAINT clickhouse_rebuild_jobs_target_table_qualified_shape
    CHECK (target_table_qualified ~ '^polaris\.[a-z][a-z0-9_]{0,127}$'),
  CONSTRAINT clickhouse_rebuild_jobs_status_allowed
    CHECK (status IN (
      'pending', 'planning', 'dry_run', 'running',
      'completed', 'failed', 'aborted'
    )),
  CONSTRAINT clickhouse_rebuild_jobs_reason_length
    CHECK (length(reason) >= 1 AND length(reason) <= 1024),
  CONSTRAINT clickhouse_rebuild_jobs_requester_length
    CHECK (length(requester_actor_label) >= 1 AND length(requester_actor_label) <= 256),
  CONSTRAINT clickhouse_rebuild_jobs_range_paired
    CHECK (
      (source_range_from IS NULL AND source_range_to IS NULL)
      OR (source_range_from IS NOT NULL AND source_range_to IS NOT NULL)
    ),
  CONSTRAINT clickhouse_rebuild_jobs_range_to_after_from
    CHECK (
      source_range_from IS NULL
      OR source_range_to IS NULL
      OR source_range_to >= source_range_from
    ),
  CONSTRAINT clickhouse_rebuild_jobs_rows_estimated_nonneg
    CHECK (rows_estimated IS NULL OR rows_estimated >= 0),
  CONSTRAINT clickhouse_rebuild_jobs_partitions_estimated_nonneg
    CHECK (partitions_estimated IS NULL OR partitions_estimated >= 0),
  CONSTRAINT clickhouse_rebuild_jobs_error_pair
    CHECK (
      (error_class IS NULL AND error_message IS NULL)
      OR (error_class IS NOT NULL AND error_message IS NOT NULL)
    ),
  CONSTRAINT clickhouse_rebuild_jobs_error_status_consistent
    CHECK (
      (error_class IS NULL AND status <> 'failed')
      OR (error_class IS NOT NULL AND status = 'failed')
    ),
  CONSTRAINT clickhouse_rebuild_jobs_error_class_length
    CHECK (error_class IS NULL OR (length(error_class) >= 1 AND length(error_class) <= 64)),
  CONSTRAINT clickhouse_rebuild_jobs_error_message_length
    CHECK (error_message IS NULL OR length(error_message) <= 2048),
  CONSTRAINT clickhouse_rebuild_jobs_started_after_created
    CHECK (started_at IS NULL OR started_at >= created_at),
  CONSTRAINT clickhouse_rebuild_jobs_completed_after_started
    CHECK (
      completed_at IS NULL
      OR (started_at IS NOT NULL AND completed_at >= started_at)
      OR (started_at IS NULL AND completed_at >= created_at)
    ),
  CONSTRAINT clickhouse_rebuild_jobs_updated_after_created
    CHECK (updated_at >= created_at)
);

-- "What rebuilds are in flight?" — operator triage and future planner
-- pickup query.
CREATE INDEX clickhouse_rebuild_jobs_status_created_idx
  ON clickhouse_rebuild_jobs (status, created_at DESC);

-- "What rebuilds have we run for this projection?" — per-projection
-- history path used by `polaris clickhouse-rebuild list --projection`.
CREATE INDEX clickhouse_rebuild_jobs_projection_created_idx
  ON clickhouse_rebuild_jobs (target_projection, created_at DESC);

-- migrate:down

DROP INDEX IF EXISTS clickhouse_rebuild_jobs_projection_created_idx;
DROP INDEX IF EXISTS clickhouse_rebuild_jobs_status_created_idx;
DROP TABLE IF EXISTS clickhouse_rebuild_jobs;
