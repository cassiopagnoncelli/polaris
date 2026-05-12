-- migrate:up
--
-- Create the `audit_records` table.
--
-- Every state-changing CLI command writes one row here. The row is the
-- authoritative audit trail for runtime/control-plane mutations; the
-- structured-log line that earlier P6 tasks emitted stays for operator
-- convenience, but this table is the source of truth from P6-006 onward.
--
-- Audit records hold mutable runtime state, so storing them in PostgreSQL is
-- on-spec for Polaris's "file-heavy, DB-light" rule
-- (docs/architecture/02-control-plane.md "PostgreSQL Owns"). Semantic platform
-- truth (event schemas, destination mappings, processor semantics) never
-- enters this table — audit rows reference target IDs and capture before/after
-- snapshots of OPERATIONAL state, not semantic definitions.
--
-- See:
--   - docs/architecture/02-control-plane.md
--       "Operator Identity and Audit Actor" — actor sources and the rule
--   - docs/architecture/09-engineering-standards.md "IDs and Timestamps"
--       (UUIDv7, UTC `timestamptz`)
--   - docs/implementation/tasks/P6-006-audit-export-cli.md
--
-- Schema rules:
--
--   - `audit_id` is a UUIDv7 stored as text. Generation lives in application
--     code (`uuid.v7()`), mirroring the prefix-style ids used elsewhere
--     (`polaris_ak_<uuidv7>`, `polaris_dst_<uuidv7>`). Audit ids are not
--     operator-facing, so we skip the prefix — a bare UUIDv7 keeps the column
--     compatible with future log/aggregation tooling.
--
--   - `actor_source` is one of `declared`, `cli`, `migration`, `system`. The
--     v1 CLI always writes `cli` until P6-007 wires authenticated operator
--     tokens. Migrations and system batch jobs use their own values when they
--     stamp audit rows (P11+).
--
--   - `actor_label` is a stable string identifying the operator. v1: `cli`;
--     post-P6-007: `cli:<email>`. The pair (actor_source, actor_label) is
--     intentionally redundant — `actor_source` answers "how did we know who"
--     and `actor_label` answers "who". Both are kept so a P6-007 rotation
--     does not invalidate historical rows.
--
--   - `action` is the verb (`destinations.enable`, `processors.disable`,
--     `keys.create`, `keys.revoke`, `keys.rotate`, ...). Free-form text so a
--     new task can write new verbs without a CHECK widening, but always uses
--     the `<group>.<verb>` shape that matches the CLI's
--     `CommandDefinition.id`.
--
--   - `target_type` is the noun (`destination`, `processor_activation`,
--     `api_key`, `project`, `source`). Free-form text on the same logic as
--     `action`.
--
--   - `target_id` is the canonical id of the row the action touched, e.g.
--     `polaris_dst_<uuidv7>`, `polaris_ak_<uuidv7>`,
--     `<processor>:<version>:<project>:<env>`. For idempotent no-op runs the
--     recorder is NOT called, so target_id is always meaningful when the row
--     exists.
--
--   - `project_id` is set when the target is project-scoped; cross-project
--     actions leave it NULL. Foreign key to `projects` so an audit row cannot
--     dangle when its target's project is invalid. Cross-project actions
--     (e.g. P6-007 operator token issuance) carry NULL.
--
--   - `environment` is set when the action is environment-scoped. The same
--     closed set as elsewhere (`development | staging | production`); the
--     CHECK enforces it.
--
--   - `before` and `after` are JSONB snapshots of the OPERATIONAL row state
--     just before/after the mutation. `before` is NULL for creates; `after`
--     is NULL for hard deletes. Snapshots are operational, not semantic —
--     they store the runtime fields the recorder receives, never event
--     schemas, mapping rules, or processor transform logic.
--
--   - `reason` is the operator-supplied rationale (`destinations.disable
--     --reason <text>`, `keys.revoke --reason <text>`). NULL when the
--     command does not require one. The recorder stores it verbatim;
--     redaction policies live above the recorder, not in the schema.
--
--   - `request_id` correlates the row with the CLI invocation. Today it
--     defaults to the audit_id at write time; once the control-plane API
--     lands (P6-000), the API stamps a per-request correlation id and the
--     CLI surfaces it through here. Always populated so log queries can
--     join audit rows to log lines.
--
--   - `created_at` defaults to `now()` in UTC (the database is pinned to
--     UTC by the bootstrap migration).
--
-- Indexes:
--
--   - `(target_type, target_id, created_at DESC)` answers "what happened to
--     this row?" — the most common audit query and the path used by
--     `polaris audit list --target-type X --target-id Y`.
--
--   - `(project_id, environment, created_at DESC)` answers "what changed in
--     this project / environment recently?" — the path used by
--     `polaris audit list --project X --env Y`.
--
--   - `(actor_label, created_at DESC)` answers "what did this operator do?"
--     — the path used by `polaris audit list --actor X` and the basis of
--     any future operator-activity dashboard.
--
-- Hard rule baked into the schema:
--
--   - NO `secret`, `token`, `plaintext`, `password`, or similar column. The
--     audit row may reference a secret_ref but NEVER the resolved value.
--     The recorder is the choke point: it accepts `before` / `after`
--     snapshots that have already had any secret-resolved values stripped
--     by the calling command.

CREATE TABLE audit_records (
  audit_id          text        PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  actor_source      text        NOT NULL,
  actor_label       text        NOT NULL,
  action            text        NOT NULL,
  target_type       text        NOT NULL,
  target_id         text        NOT NULL,
  project_id        text                 REFERENCES projects(project_id),
  environment       text,
  before            jsonb,
  after             jsonb,
  reason            text,
  request_id        text,
  CONSTRAINT audit_records_actor_source_allowed
    CHECK (actor_source IN ('declared', 'cli', 'migration', 'system')),
  CONSTRAINT audit_records_actor_label_nonempty
    CHECK (length(actor_label) >= 1 AND length(actor_label) <= 256),
  CONSTRAINT audit_records_action_nonempty
    CHECK (length(action) >= 1 AND length(action) <= 128),
  CONSTRAINT audit_records_target_type_nonempty
    CHECK (length(target_type) >= 1 AND length(target_type) <= 64),
  CONSTRAINT audit_records_target_id_nonempty
    CHECK (length(target_id) >= 1 AND length(target_id) <= 256),
  CONSTRAINT audit_records_environment_allowed
    CHECK (environment IS NULL OR environment IN ('development', 'staging', 'production')),
  CONSTRAINT audit_records_reason_length
    CHECK (reason IS NULL OR length(reason) <= 1024)
);

-- "What happened to this row?" — primary audit-trail query.
CREATE INDEX audit_records_target_idx
  ON audit_records (target_type, target_id, created_at DESC);

-- "What changed in this project recently?" — operator overview query.
CREATE INDEX audit_records_project_env_idx
  ON audit_records (project_id, environment, created_at DESC);

-- "What did this operator do?" — accountability query.
CREATE INDEX audit_records_actor_idx
  ON audit_records (actor_label, created_at DESC);

-- migrate:down

DROP TABLE audit_records;
