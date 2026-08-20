-- migrate:up
--
-- Create the `projects` table.
--
-- Projects are file-backed declarations (under `catalog/projects/`) that are
-- materialized into PostgreSQL for runtime use. The catalog YAML files are
-- the source of truth for semantic project membership; this table holds the
-- runtime row that the ingester, control plane, and audit log reference by
-- stable `project_id`.
--
-- See:
--   - docs/architecture/02-control-plane.md "Projects and Environments"
--   - docs/implementation/tasks/P6-002-projects-sources-cli.md
--
-- Schema rules:
--   - `project_id` matches the YAML filename slug (lowercase, snake/dash).
--   - `display_name` is human-facing.
--   - `owner` records the responsible team or operator (free text, short).
--   - `description` is short marketing-free prose.
--   - `status` toggles project visibility; semantic declarations stay in YAML.
--   - Timestamps are `timestamptz` so they match the platform UTC convention.

CREATE TABLE projects (
  project_id     text        PRIMARY KEY,
  display_name   text        NOT NULL,
  owner          text        NOT NULL,
  description    text        NOT NULL,
  status         text        NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_project_id_format
    CHECK (project_id ~ '^[a-z][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT projects_status_allowed
    CHECK (status IN ('active', 'disabled'))
);

-- migrate:down

DROP TABLE projects;
