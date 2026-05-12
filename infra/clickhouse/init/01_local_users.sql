-- Polaris ClickHouse: local/dev user bootstrap.
--
-- This file is LOCAL ONLY. It creates concrete ClickHouse users tied to
-- the `polaris_service` and `polaris_operator` roles defined in
-- sql/clickhouse/roles/00_roles.sql so workspace code (services, the CLI,
-- the vertical-slice smoke test) can authenticate against the local stack.
--
-- Production never applies this file. Production users come from the
-- secret provider (P11-004) and live outside the SQL DDL.
--
-- Apply order: after sql/clickhouse/ has been migrated (so roles exist).
-- The local-stack bootstrap script (scripts/clickhouse-bootstrap-local.mjs)
-- runs `pnpm clickhouse:migrate` first, then this file, so the GRANT
-- statements below resolve cleanly.
--
-- Passwords:
--   The local passwords are deliberately weak ("polaris_service",
--   "polaris_operator"). They are NOT secrets — they exist so that
--   `@polaris/shared-clickhouse` can connect with a non-default profile in
--   local/dev. Anything stronger would force a per-developer secret-sharing
--   step that defeats the "pnpm setup just works" promise.
--
-- Idempotency:
--   Every statement uses IF NOT EXISTS where ClickHouse supports it.
--   GRANTs are additive; re-running the file converges.

-- ---------------------------------------------------------------
-- polaris_service: service-tier connections.
-- ---------------------------------------------------------------

CREATE USER IF NOT EXISTS polaris_service
    IDENTIFIED WITH plaintext_password BY 'polaris_service'
    HOST ANY
    DEFAULT ROLE polaris_service;

GRANT polaris_service TO polaris_service;

-- ---------------------------------------------------------------
-- polaris_operator: operator-tier connections.
-- ---------------------------------------------------------------

CREATE USER IF NOT EXISTS polaris_operator
    IDENTIFIED WITH plaintext_password BY 'polaris_operator'
    HOST ANY
    DEFAULT ROLE polaris_operator;

GRANT polaris_operator TO polaris_operator;
