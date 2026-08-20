-- migrate:up
--
-- Polaris bootstrap migration.
--
-- This migration is intentionally minimal. The Polaris control plane is
-- database-light: PostgreSQL only stores mutable runtime/control state
-- (api_keys, sources, destination_instances, processor_runs, replay_jobs,
-- delivery_records, audit_records, operator_tokens, topic_isolations,
-- identity_links). Those tables are scaffolded by later tasks (P6-*, P7-*,
-- P9-*, P11-*), not here.
--
-- What this migration does:
--   1. Pins the database timezone to UTC so every `now()` and `timestamptz`
--      default matches Polaris's UTC-everywhere convention
--      (docs/architecture/09-engineering-standards.md, "IDs and Timestamps").
--
-- What this migration deliberately does NOT do:
--   - create application tables — those belong to their owning task cards
--   - encode event schemas, destination mappings, or processor semantics —
--     those are file-backed code, not SQL data
--     (docs/architecture/02-control-plane.md, "Files and Code Own")
--   - install pgcrypto / uuid-ossp — Polaris generates UUIDv7 in application
--     code; no Postgres-side hashing or UUID helper is needed yet.

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', current_database());
END
$$;

-- migrate:down

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I RESET timezone', current_database());
END
$$;
