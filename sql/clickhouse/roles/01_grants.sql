-- Polaris ClickHouse: role grants
--
-- Apply AFTER all schema objects (analytics_events_queue,
-- analytics_ingest_log, analytics_raw, projection tables, MVs) have
-- been created. Re-run this file whenever a new projection table is
-- added — the polaris_service role needs an explicit SELECT grant on
-- each new projection.
--
-- Policy summary:
--   polaris_service
--     +  SELECT on polaris.analytics_ingest_log
--     +  SELECT on every projection table
--     -  NO grant on polaris.analytics_raw
--     -  NO grant on polaris.analytics_events_queue (Kafka Engine)
--     -  NO grant on any materialized view (MVs read into TO-tables;
--        their TO-tables are either projections or analytics_raw,
--        and only the projections are exposed to services)
--
--   polaris_operator
--     +  SELECT on every table in `polaris` (including
--        analytics_raw)
--     +  Schema-evolution grants (CREATE / ALTER / DROP /
--        INSERT / TRUNCATE / SYSTEM RELOAD) on `polaris`
--     -  No grants outside the `polaris` database.
--
-- The Kafka Engine table polaris.analytics_events_queue is NEVER
-- granted to either role for direct SELECT. Operators who need to
-- diagnose ingestion lag use system tables (system.kafka_consumers,
-- system.replicas) plus the analytics_ingest_log, not the Kafka
-- Engine table itself. See docs/architecture/07-clickhouse.md
-- "Query Patterns / What is banned".

-- ---------------------------------------------------------------
-- polaris_service: read-only access to the safe surface only.
-- ---------------------------------------------------------------

GRANT ON CLUSTER '{cluster}'
    SELECT ON polaris.analytics_ingest_log
    TO polaris_service;

-- Per-projection grants. One line per projection table; add another
-- GRANT statement when a new projection lands.
GRANT ON CLUSTER '{cluster}'
    SELECT ON polaris.event_daily_counts
    TO polaris_service;

-- Defensive REVOKEs. ClickHouse role grants are additive across
-- statements; these REVOKEs guarantee that even if a future grant
-- in this file accidentally widens scope, analytics_raw and the
-- Kafka Engine table remain off-limits for polaris_service.
REVOKE ON CLUSTER '{cluster}'
    ALL ON polaris.analytics_raw
    FROM polaris_service;

REVOKE ON CLUSTER '{cluster}'
    ALL ON polaris.analytics_events_queue
    FROM polaris_service;

-- ---------------------------------------------------------------
-- polaris_operator: broader access for replay/rebuild and ad-hoc
-- investigation.
-- ---------------------------------------------------------------

-- SELECT covers analytics_raw and all current/future projection
-- tables in `polaris`. New projection tables do not require a grant
-- update for operators.
GRANT ON CLUSTER '{cluster}'
    SELECT ON polaris.*
    TO polaris_operator;

-- DDL and write grants needed for replay/rebuild flows (P7-005) and
-- for applying schema migrations. These do NOT extend to the Kafka
-- Engine table's underlying transport — Kafka offsets are managed
-- by the consumer group, not by ALTER on the table.
GRANT ON CLUSTER '{cluster}'
    CREATE, ALTER, DROP, INSERT, TRUNCATE, OPTIMIZE
    ON polaris.*
    TO polaris_operator;

GRANT ON CLUSTER '{cluster}'
    SYSTEM RELOAD CONFIG, SYSTEM FLUSH LOGS
    TO polaris_operator;

-- Operator workflows occasionally need to inspect system tables
-- (system.parts, system.replicas, system.kafka_consumers,
-- system.merges) to diagnose ingestion or replay state. These are
-- read-only and do not expose customer data.
GRANT ON CLUSTER '{cluster}'
    SELECT ON system.parts,
    SELECT ON system.replicas,
    SELECT ON system.kafka_consumers,
    SELECT ON system.merges,
    SELECT ON system.mutations,
    SELECT ON system.tables,
    SELECT ON system.columns
    TO polaris_operator;

-- Even for operators, the Kafka Engine table is never granted for
-- direct SELECT. The MV pipeline is the only authorized reader.
REVOKE ON CLUSTER '{cluster}'
    SELECT ON polaris.analytics_events_queue
    FROM polaris_operator;
