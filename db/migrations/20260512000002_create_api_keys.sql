-- migrate:up
--
-- Polaris control plane: api_keys table.
--
-- API keys are source-scoped write credentials: each key is bound to one
-- (project_id, environment, source_id, source_type) tuple. The ingester
-- authenticates incoming requests against this table, stamps the trusted
-- (project_id, environment, source) tuple from the resolved row, and forbids
-- producers from sending or overriding those fields.
--
-- Hard rules baked into the schema:
--
--   - Raw key material is NEVER stored. Only an argon2id hash plus metadata.
--   - The hash algorithm column is kept explicit so a future migration can
--     introduce a parameter bump (or, post-argon2id-as-default, an entirely
--     new primitive) without rewriting history.
--   - status is a discrete string ('active' | 'revoked') rather than a
--     boolean so future states (e.g. 'paused', 'pending_rotation') can land
--     without a column type change. The ingester treats anything other than
--     'active' as not-usable.
--   - revoked_at and last_used_at are nullable timestamptz columns; the CLI
--     stamps them when the lifecycle changes.
--   - The owning task for the lifecycle CLI is P6-003 (api keys create /
--     revoke / rotate). This migration ships the schema first so the
--     ingester can authenticate against it in P2-002.
--
-- Anchored to the architecture docs:
--   - docs/architecture/02-control-plane.md "API Keys"
--   - docs/architecture/04-ingestion-and-sdks.md "Ingester Responsibilities"
--   - docs/architecture/01-event-contract.md "Trusted Metadata"

CREATE TABLE api_keys (
  api_key_id      text PRIMARY KEY,
  project_id      text NOT NULL,
  environment     text NOT NULL,
  source_id       text NOT NULL,
  source_type     text NOT NULL,
  hash            text NOT NULL,
  hash_algorithm  text NOT NULL DEFAULT 'argon2id',
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  CONSTRAINT api_keys_status_check CHECK (status IN ('active', 'revoked'))
);

-- Lookup path for the ingester: given the prefix on the wire, the ingester
-- resolves the row by api_key_id (the public prefix doubles as the primary
-- key in v1). The composite index supports listing/active-key lookups by
-- (project, environment, source) for the lifecycle CLI.
CREATE INDEX idx_api_keys_lookup ON api_keys (project_id, environment, source_id);

-- migrate:down

DROP INDEX IF EXISTS idx_api_keys_lookup;
DROP TABLE IF EXISTS api_keys;
