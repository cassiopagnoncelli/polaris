-- Polaris ClickHouse: Kafka Engine ingestion interface
--
-- This table is the transport boundary between Redpanda's
-- `analytics.events` topic family and ClickHouse storage. It is a
-- transient ingestion interface only and MUST NOT be queried directly.
-- Materialized views downstream are the only readers.
--
-- Rationale:
--   Kafka Engine reads consume offsets. A direct SELECT from this
--   table would race with the MVs that feed analytics_ingest_log and
--   analytics_raw, leading to lost rows. The architecture docs forbid
--   direct reads (see docs/architecture/07-clickhouse.md, "Query
--   Patterns / What is banned").
--
-- Format:
--   JSONEachRow is the v1 wire format (see 07-clickhouse.md).
--   Avro/Protobuf + schema registry is honest future work.
--
-- Topic family:
--   Reads from the shared `analytics.events` topic. Per-project
--   isolation (`analytics.events.<project_id>`) is handled at the
--   shared-kafka resolver layer; if/when a project graduates to a
--   dedicated topic, a sibling Kafka Engine table is created with the
--   same column shape and a project-scoped consumer group.

CREATE TABLE IF NOT EXISTS polaris.analytics_events_queue ON CLUSTER '{cluster}'
(
    -- Envelope fields. Mirror the canonical event envelope defined in
    -- docs/architecture/01-event-contract.md. Nested fields land as
    -- raw JSON strings so the ingestion layer stays schema-tolerant;
    -- downstream MVs extract what they need.
    event_id          String,
    event             LowCardinality(String),
    schema_version    UInt32,
    project_id        LowCardinality(String),
    environment       LowCardinality(String),
    occurred_at       DateTime64(3, 'UTC'),
    ingested_at       DateTime64(3, 'UTC'),
    source            String,                  -- JSON object
    identity          String,                  -- JSON object
    context           String,                  -- JSON object
    -- consent/privacy are informational in v1. ClickHouse 25+ forbids
    -- DEFAULT/MATERIALIZED/EPHEMERAL on Kafka Engine columns, so omitted
    -- JSON fields fall back to the type's zero value (empty String) —
    -- which matches the prior `DEFAULT ''` semantics exactly.
    consent           String,                  -- JSON object (informational in v1)
    privacy           String,                  -- JSON object (informational in v1)
    properties        String,                  -- JSON object

    -- Processor metadata stamped by the analytics processor that writes
    -- to `analytics.events`. _version is the monotonic per-event-key
    -- revision used by ReplacingMergeTree and argMax. Defaulting for
    -- omitted JSON fields used to live here (`DEFAULT
    -- toUnixTimestamp64Milli(ingested_at)`); CH 25+ disallows DEFAULT
    -- on Kafka Engine, so the same fallback now lives in the two MVs
    -- that read this table (21_mv_queue_to_ingest_log.sql,
    -- 31_mv_queue_to_raw.sql) — see the `_version` projection there.
    processor_name    LowCardinality(String),
    processor_version LowCardinality(String),
    _version          UInt64
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list           = 'redpanda:9092',
    kafka_topic_list            = 'analytics.events',
    kafka_group_name            = 'polaris-clickhouse-analytics',
    kafka_format                = 'JSONEachRow',
    kafka_num_consumers         = 1,
    kafka_max_block_size        = 1048576,
    kafka_skip_broken_messages  = 0,
    kafka_thread_per_consumer   = 0,
    -- Tolerate envelope evolution: skip unknown top-level JSON fields
    -- rather than failing the whole batch.
    input_format_skip_unknown_fields = 1;

-- IMPORTANT: do not add SELECT-friendly indexes or run SELECT against
-- this table from application code. The two materialized views below
-- (21_mv_queue_to_ingest_log.sql, 31_mv_queue_to_raw.sql) are the
-- only sanctioned readers.
