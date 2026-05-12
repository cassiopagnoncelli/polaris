-- Polaris ClickHouse: role definitions
--
-- Two roles ship in v1, per docs/architecture/07-clickhouse.md
-- "Access Control / Roles":
--
--   polaris_service   SELECT on projection tables and the ingest log
--                     only. Used by the ingester, processors,
--                     destination consumers, the future dashboard
--                     API, and the CLI's routine inspection paths.
--                     The connection literally cannot read
--                     analytics_raw or the Kafka Engine table.
--
--   polaris_operator  Broader access including analytics_raw. Used
--                     by replay/rebuild jobs, ad-hoc operator
--                     investigation, and the CLI's operator-tier
--                     commands.
--
-- Both roles exist in local/dev and production. Grants are defined
-- separately in 01_grants.sql so role identity and grant policy can
-- evolve on different cadences.
--
-- See sql/clickhouse/roles/README.md for the role model rationale
-- and the helper-package mapping (packages/shared-clickhouse/).

CREATE ROLE IF NOT EXISTS polaris_service ON CLUSTER '{cluster}';
CREATE ROLE IF NOT EXISTS polaris_operator ON CLUSTER '{cluster}';

-- Roles are useless until they are granted to a user. User creation
-- and credential provisioning live with the secret provider
-- (docs/architecture/11-production-readiness.md "Secret Management"
-- and P11-004) — this DDL only defines the roles themselves.
