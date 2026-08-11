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
--     -  NO grant on polaris.analytics_events_queue (Null ingestion
--        interface; clickhouse-sink INSERTs, MVs read)
--     -  NO grant on any materialized view (MVs read into TO-tables;
--        their TO-tables are either projections or analytics_raw,
--        and only the projections are exposed to services)
--
--   polaris_sink
--     +  INSERT on polaris.analytics_events_queue
--     -  NO SELECT on anything, anywhere
--
--   polaris_operator
--     +  SELECT on every table in `polaris` (including
--        analytics_raw)
--     +  Schema-evolution grants (CREATE / ALTER / DROP /
--        INSERT / TRUNCATE / SYSTEM RELOAD) on `polaris`
--     -  No grants outside the `polaris` database.
--
-- The ingestion interface table polaris.analytics_events_queue is
-- NEVER granted to either role for direct SELECT. It is a Null engine
-- (see 10_analytics_events_queue.sql), so a SELECT would return an
-- empty result and read as "no data ingested" during an incident.
-- Operators diagnosing ingestion lag use the Polaris metric
-- `polaris_clickhouse_sink_lag_seconds`, system.replicas, and the
-- analytics_ingest_log. See docs/architecture/07-clickhouse.md
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
-- ingestion interface table remain off-limits for polaris_service.
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
-- for applying schema migrations. These do NOT extend to the
-- transport itself — stream offsets are managed
-- by the consumer group, not by ALTER on the table.
GRANT ON CLUSTER '{cluster}'
    CREATE, ALTER, DROP, INSERT, TRUNCATE, OPTIMIZE
    ON polaris.*
    TO polaris_operator;

-- CH 25+ requires an explicit `ON <scope>` for SYSTEM privileges —
-- `ON *.*` means global, matching the prior implicit behaviour on CH 24.
GRANT ON CLUSTER '{cluster}'
    SYSTEM RELOAD CONFIG, SYSTEM FLUSH LOGS
    ON *.*
    TO polaris_operator;

-- Operator workflows occasionally need to inspect system tables
-- (system.parts, system.replicas, system.merges) to diagnose
-- ingestion or replay state. These are read-only and do not expose
-- customer data.
--
-- `system.kafka_consumers` is gone from this list with the RabbitMQ
-- migration: ClickHouse no longer consumes anything, so the table is
-- empty and granting it would just send an operator down a dead end
-- mid-incident.
--
-- One GRANT per table: CH 25+ rejects multiple `<priv> ON db.table`
-- entries in a single GRANT (the earlier comma-separated form was
-- silently accepted on CH 24 but is not standard).
GRANT ON CLUSTER '{cluster}' SELECT ON system.parts             TO polaris_operator;
GRANT ON CLUSTER '{cluster}' SELECT ON system.replicas          TO polaris_operator;
GRANT ON CLUSTER '{cluster}' SELECT ON system.merges            TO polaris_operator;
GRANT ON CLUSTER '{cluster}' SELECT ON system.mutations         TO polaris_operator;
GRANT ON CLUSTER '{cluster}' SELECT ON system.tables            TO polaris_operator;
GRANT ON CLUSTER '{cluster}' SELECT ON system.columns           TO polaris_operator;
-- system.query_log carries the per-INSERT `written_rows` the rebuild
-- driver looks up after each `rebuildPartition` (ENCXI9BE). Without
-- this grant the driver's lookup returns ACCESS_DENIED, the backoff
-- retry exhausts, and the rebuild's `rows_inserted_total` silently
-- resolves to zero.
GRANT ON CLUSTER '{cluster}' SELECT ON system.query_log         TO polaris_operator;

-- Even for operators, the ingestion interface table is never granted
-- for direct SELECT. The MV pipeline is the only authorized reader.
REVOKE ON CLUSTER '{cluster}'
    SELECT ON polaris.analytics_events_queue
    FROM polaris_operator;

-- ---------------------------------------------------------------
-- polaris_sink: write-only access to the ingestion interface.
-- ---------------------------------------------------------------
--
-- The ClickHouse sink (consumers/clickhouse-sink) is the only writer
-- into ClickHouse. It needs INSERT on the ingestion interface table
-- and nothing else: the materialized views run under the table's own
-- privileges, so the sink never touches analytics_ingest_log,
-- analytics_raw, or any projection directly.
--
-- Read privileges are deliberately absent rather than merely unused.
-- A sink that could SELECT would be a full read path into every
-- customer event, guarded only by application code.

GRANT ON CLUSTER '{cluster}'
    INSERT ON polaris.analytics_events_queue
    TO polaris_sink;

-- Defensive REVOKE, mirroring the polaris_service pattern: even if a
-- future grant in this file widens scope, the sink stays write-only.
REVOKE ON CLUSTER '{cluster}'
    SELECT ON polaris.analytics_raw
    FROM polaris_sink;

REVOKE ON CLUSTER '{cluster}'
    SELECT ON polaris.analytics_ingest_log
    FROM polaris_sink;
