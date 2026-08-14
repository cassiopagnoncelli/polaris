-- Polaris ClickHouse: ingestion interface table
--
-- This table is the transport boundary between the `analytics.events`
-- stream family and ClickHouse storage. It is a transient ingestion
-- interface only and MUST NOT be queried directly. Materialized views
-- downstream are the only readers.
--
-- ## Why this is a Null engine and not a Kafka engine
--
-- Until the RabbitMQ migration this was `ENGINE = Kafka`: ClickHouse
-- itself held a consumer group against Redpanda and pulled rows. RabbitMQ
-- streams have no ClickHouse engine, and the AMQP `RabbitMQ` engine that
-- does exist is a materially weaker thing — it speaks AMQP 0-9-1, has no
-- offset concept (so no offset-based recovery after a restart), and its
-- virtual columns are `_channel_id` / `_delivery_tag` rather than the
-- `_topic` / `_partition` / `_offset` lineage the ingest log records.
--
-- So Polaris owns the delivery instead: `async/warehouse/clickhouse-sink/v1`
-- consumes the `analytics.events` partition streams and INSERTs batches
-- here. The engine is `Null`, which stores nothing and exists purely to
-- fan INSERTs into the materialized views — the same role the Kafka
-- engine table played, minus the consuming.
--
-- What this changes operationally:
--
--   - Lineage columns (`_topic`, `_partition`, `_offset`) are now real
--     columns stamped by the sink from the stream name, partition index,
--     and stream offset. Same meaning, same names, explicitly written.
--   - Recovery is at-least-once via the sink's checkpoint (it advances
--     only after ClickHouse acknowledges the INSERT), so a crash
--     re-inserts a batch. `analytics_raw`'s ReplacingMergeTree collapses
--     it — exactly as it already did for Kafka-engine redelivery.
--   - Ingestion lag is a Polaris metric
--     (`polaris_clickhouse_sink_lag_seconds`) rather than a
--     ClickHouse-internal one.
--
-- Format: the sink INSERTs `JSONEachRow`, unchanged from the v1 wire
-- format (see 07-clickhouse.md). Avro/Protobuf + schema registry remains
-- honest future work.
--
-- Stream family: reads from the shared `analytics.events` family.
-- Per-project isolation (`analytics.events.<project_id>`) is handled at
-- the shared-transport resolver layer; an isolated project is an extra
-- family the sink subscribes to, not a second table here.

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
    -- consent/privacy are informational in v1.
    consent           String    DEFAULT '',    -- JSON object (informational in v1)
    privacy           String    DEFAULT '',    -- JSON object (informational in v1)
    properties        String    DEFAULT '',    -- JSON object

    -- Processor metadata stamped by the analytics processor that writes
    -- to `analytics.events`. _version is the monotonic per-event-key
    -- revision used by ReplacingMergeTree and argMax. The Kafka-engine
    -- era could not carry DEFAULT expressions (CH 25+ forbids them on
    -- Kafka Engine), so the fallback lived in the two MVs; a Null engine
    -- has no such restriction, but the MV-side fallback is kept as-is
    -- rather than moved, because changing where it lives would change
    -- nothing and risk a silent behaviour difference between the two MVs.
    processor_name    LowCardinality(String),
    processor_version LowCardinality(String),
    _version          UInt64    DEFAULT 0,

    -- Transport lineage, stamped by clickhouse-sink. These were Kafka
    -- Engine virtual columns; they are ordinary columns now.
    --   _topic      concrete partition stream, e.g. `analytics.events-2`
    --   _partition  partition index within the super stream
    --   _offset     RabbitMQ stream offset of the message
    _topic            LowCardinality(String) DEFAULT '',
    _partition        UInt16    DEFAULT 0,
    _offset           UInt64    DEFAULT 0
)
-- Null: rows are dropped on write and only reach the materialized views.
-- Storing them here would double every byte the ingest log already keeps.
ENGINE = Null;

-- IMPORTANT: do not add SELECT-friendly indexes or run SELECT against
-- this table from application code. A Null engine returns nothing on
-- SELECT by construction; the two materialized views
-- (21_mv_queue_to_ingest_log.sql, 31_mv_queue_to_raw.sql) are the only
-- sanctioned readers.
