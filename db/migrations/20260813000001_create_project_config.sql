-- migrate:up
--
-- Create `project_config` and `project_config_versions`.
--
-- Per-(project, environment) configuration values, one row per key,
-- namespaced by the component that reads them. This is the value store for
-- the project-config programme (docs/implementation/project-config-plan.md
-- §3.2). The narrowed platform rule:
--
--   PostgreSQL stores VALUES for configuration keys declared in component
--   code. It never stores mappings, routing, transforms, or field maps.
--
-- Schema rules:
--   - Row-per-key, not blob-per-project: per-key audit, per-key validation,
--     partial writes with no read-modify-write race between operators.
--   - `is_secret_ref = true` rows hold a `provider:ref` string (same pattern
--     as `destinations.secret_ref`), NEVER a plaintext secret. The CHECK is
--     the last line of defence and holds even against direct SQL.
--
--     NOTE (added later, not a rewrite): reversed by
--     20260813000004_plaintext_project_secrets.sql. The column is now
--     `is_secret`, it means "this value is sensitive" rather than "this value
--     is a pointer", and the value IS the secret.
--   - `project_config_versions` carries one monotonic counter per
--     (project, environment); every write bumps it in the same transaction.
--     Cache revalidation reads this one row instead of re-reading values.
--   - `environment` is text + CHECK, matching every other environment-scoped
--     table. The TypeScript mirror is `POLARIS_ENVIRONMENTS` in
--     @polaris/shared-environments.
--
-- See:
--   - docs/implementation/project-config-plan.md "Schema", "Cache and invalidation"
--   - db/migrations/20260512000005_create_destinations.sql (secret_ref pattern)

CREATE TABLE project_config (
  project_id    text        NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  environment   text        NOT NULL,
  namespace     text        NOT NULL,
  config_key    text        NOT NULL,
  value         jsonb       NOT NULL,
  is_secret_ref boolean     NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text        NOT NULL,
  PRIMARY KEY (project_id, environment, namespace, config_key),
  CONSTRAINT project_config_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT project_config_namespace_format
    CHECK (namespace ~ '^[a-z][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT project_config_key_format
    CHECK (config_key ~ '^[a-z][a-z0-9_]{0,62}[a-z0-9]$'),
  CONSTRAINT project_config_secret_ref_shape
    CHECK (
      NOT is_secret_ref
      OR (jsonb_typeof(value) = 'string'
          AND value #>> '{}' ~ '^[a-z][a-z0-9_-]*:[^[:space:]]+$')
    )
);

CREATE TABLE project_config_versions (
  project_id   text        NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  environment  text        NOT NULL,
  version      bigint      NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment),
  CONSTRAINT project_config_versions_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production'))
);

CREATE INDEX project_config_lookup_idx
  ON project_config (project_id, environment, namespace);

-- migrate:down

DROP TABLE project_config_versions;
DROP TABLE project_config;
