-- migrate:up
--
-- Create the `processor_activations` table.
--
-- Per `(processor_name, processor_version, project_id, environment)`, this row
-- records whether the processor is enabled in that scope, when it was last
-- toggled, and who toggled it. Processors are versioned (immutable) TypeScript
-- services that live under `processors/<name>/v<n>/`; the SEMANTIC definition
-- of each processor — inputs, outputs, mode, transform — lives in
-- `processor.manifest.yaml` next to the code, NEVER in PostgreSQL. This table
-- only flips the runtime switch.
--
-- This is the central architectural rule for P6-005: the CLI must refuse to
-- write semantic processor config. The schema gives it nowhere to store any —
-- the column set is restricted to the four scoping columns plus the runtime
-- state, the audit timestamps, and a `last_changed_by` actor label. Tests in
-- `apps/polaris-cli/test/processors-commands.test.ts` assert the absence of
-- transform-rule-shaped columns on both the SQL schema and the typed
-- `ProcessorActivationsTable` interface.
--
-- See:
--   - docs/architecture/05-processors-and-replay.md
--     "Processor Configuration" (PostgreSQL stores ONLY runtime operational
--     settings; semantic transformation rules MUST live in versioned code).
--   - docs/architecture/02-control-plane.md "PostgreSQL Owns"
--   - docs/implementation/tasks/P6-005-processor-runtime-cli.md
--
-- Schema rules:
--   - Composite PK is `(processor_name, processor_version, project_id,
--     environment)`. One row per scope; the CLI's `enable` and `disable`
--     commands UPSERT against this tuple.
--   - `processor_version` is free-form text rather than a closed-set CHECK
--     because the version directory tree (`processors/<name>/v1/`,
--     `processors/<name>/v2/`, ...) is the source of truth. A CHECK
--     constraint here would be too brittle — when v2 lands, the migration
--     would need to widen — so the column accepts any plausible version
--     string and the CLI's manifest loader is the actual gate.
--   - `enabled_state` is an enum-like text column (`enabled` | `disabled`).
--     The CLI flips it via `enable` / `disable` commands; the runtime treats
--     anything other than `enabled` as not-runnable.
--   - `enabled_at` is set whenever a row transitions to `enabled` (also on
--     initial insert when enabled).
--   - `disabled_at` is set whenever a row transitions to `disabled`. Both
--     timestamps are kept (not just the most recent) so an operator can see
--     the last toggle in each direction at a glance.
--   - `last_changed_by` is a free-text actor label. The audit_records table
--     (P6-006) is the real audit surface; this column is a convenience marker
--     defaulted to 'cli' until P6-007 wires authenticated operator identities
--     through.
--   - `project_id` FK to projects(project_id) enforces materialized order;
--     attempting to enable a processor for an undeclared project fails fast.
--
-- Hard rule baked into the schema (wording narrowed 2026-08-13; see
-- docs/implementation/project-config-plan.md §2):
--   - PostgreSQL stores VALUES for configuration keys declared in component
--     code (the `project_config` table); it never stores transformation
--     semantics. NO `transform`, `rule`, `mapping`, `input_topic`,
--     `output_topic`, `config_blob`, `routing`, `enrichment`, or similar
--     columns on THIS table. The manifest YAML next to the code remains the
--     only source of truth for inputs/outputs/mode/transform.

CREATE TABLE processor_activations (
  processor_name      text        NOT NULL,
  processor_version   text        NOT NULL,
  project_id          text        NOT NULL REFERENCES projects(project_id),
  environment         text        NOT NULL,
  enabled_state       text        NOT NULL DEFAULT 'enabled',
  enabled_at          timestamptz,
  disabled_at         timestamptz,
  last_changed_by     text        NOT NULL DEFAULT 'cli',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (processor_name, processor_version, project_id, environment),
  CONSTRAINT processor_activations_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT processor_activations_enabled_state_allowed
    CHECK (enabled_state IN ('enabled', 'disabled')),
  CONSTRAINT processor_activations_processor_name_format
    CHECK (processor_name ~ '^[a-z][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT processor_activations_processor_version_format
    CHECK (processor_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT processor_activations_last_changed_by_nonempty
    CHECK (length(last_changed_by) >= 1 AND length(last_changed_by) <= 256)
);

-- Lookup path for the listing command, which surfaces every
-- (project, env) activation per processor. The primary key already covers
-- the (processor_name, processor_version, ...) prefix lookups; this index
-- covers the inverse query — "what processors are activated for this
-- (project, environment)?" — used by the runtime helpers (P8-001) when
-- deciding which processors to spin up.
CREATE INDEX processor_activations_project_env_idx
  ON processor_activations (project_id, environment);

-- migrate:down

DROP TABLE processor_activations;
