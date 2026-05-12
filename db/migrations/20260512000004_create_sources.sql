-- migrate:up
--
-- Create the `sources` table.
--
-- Sources are explicit platform objects (e.g. `storefront-web`, `payments-api`).
-- Like projects, semantic declarations live in YAML files
-- (`catalog/sources/<project_id>/<source_id>.yaml`) and are materialized into
-- PostgreSQL so the ingester can resolve `project_id + environment + source_id`
-- against the active runtime state.
--
-- See:
--   - docs/architecture/02-control-plane.md "Sources"
--   - docs/implementation/tasks/P6-002-projects-sources-cli.md
--
-- Schema rules:
--   - `project_id` references `projects.project_id` (FK enforces materialized order).
--   - `source_id` is unique only within a project.
--   - `source_type` is a closed set (`web`, `backend`, `mobile`, `webhook`, `job`).
--   - `runtime` is a closed set (`active`, `paused`); follows the source-key
--     runtime state pattern from `02-control-plane.md`.
--   - `allowed_environments` is a sorted, deduplicated text array of fixed
--     environment names (`development`, `staging`, `production`). The CHECK
--     constraint enforces non-empty and bounded membership.
--   - `status` mirrors `projects.status` for source-level visibility.

CREATE TABLE sources (
  project_id            text        NOT NULL REFERENCES projects(project_id),
  source_id             text        NOT NULL,
  source_type           text        NOT NULL,
  owner                 text        NOT NULL,
  description           text        NOT NULL,
  runtime               text        NOT NULL DEFAULT 'active',
  allowed_environments  text[]      NOT NULL,
  status                text        NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source_id),
  CONSTRAINT sources_source_id_format
    CHECK (source_id ~ '^[a-z][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT sources_source_type_allowed
    CHECK (source_type IN ('web', 'backend', 'mobile', 'webhook', 'job')),
  CONSTRAINT sources_runtime_allowed
    CHECK (runtime IN ('active', 'paused')),
  CONSTRAINT sources_status_allowed
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT sources_allowed_environments_nonempty
    CHECK (array_length(allowed_environments, 1) >= 1),
  CONSTRAINT sources_allowed_environments_members
    CHECK (allowed_environments <@ ARRAY['development', 'staging', 'production']::text[])
);

CREATE INDEX sources_project_id_idx ON sources(project_id);

-- migrate:down

DROP TABLE sources;
