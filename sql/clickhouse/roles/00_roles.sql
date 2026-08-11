-- Polaris ClickHouse: role definitions
--
-- Three roles ship, per docs/architecture/07-clickhouse.md
-- "Access Control / Roles":
--
--   polaris_service   SELECT on projection tables and the ingest log
--                     only. Used by the ingester, processors,
--                     destination consumers, the future dashboard
--                     API, and the CLI's routine inspection paths.
--                     The connection literally cannot read
--                     analytics_raw or the ingestion interface table.
--
--   polaris_operator  Broader access including analytics_raw. Used
--                     by replay/rebuild jobs, ad-hoc operator
--                     investigation, and the CLI's operator-tier
--                     commands.
--
--   polaris_sink      INSERT on the ingestion interface table and
--                     NOTHING else — no SELECT anywhere. Used only by
--                     consumers/clickhouse-sink, which came into
--                     existence when the RabbitMQ migration removed
--                     ClickHouse's ability to consume for itself.
--                     Write-only is the correct blast radius for a
--                     process whose entire job is moving bytes in one
--                     direction: a compromised sink cannot read a
--                     single row of customer data.
--
-- Both roles exist in local/dev and production. Grants are defined
-- separately in 01_grants.sql so role identity and grant policy can
-- evolve on different cadences.
--
-- See sql/clickhouse/roles/README.md for the role model rationale
-- and the helper-package mapping (packages/shared-clickhouse/).

CREATE ROLE IF NOT EXISTS polaris_service ON CLUSTER '{cluster}';
CREATE ROLE IF NOT EXISTS polaris_operator ON CLUSTER '{cluster}';
CREATE ROLE IF NOT EXISTS polaris_sink ON CLUSTER '{cluster}';

-- Roles are useless until they are granted to a user. User creation
-- and credential provisioning live with the secret provider
-- (docs/architecture/11-production-readiness.md "Secret Management"
-- and P11-004) — this DDL only defines the roles themselves.
