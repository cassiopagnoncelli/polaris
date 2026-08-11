-- Polaris ClickHouse: ingestion interface table for derived events
--
-- Sibling of 10_analytics_events_queue.sql. Same transport boundary, same
-- Null engine, different source families: this one receives the events
-- Polaris processors *derive* rather than the source events producers
-- send.
--
--   enriched.events     enriched.geoip
--   session.events      session.started, session.ended
--   identity.events     identity.linked, identity.merged, identity.rotated
--   attribution.events  touchpoint_captured, ...
--
-- ## Why a second queue table instead of one shared queue
--
-- The alternative is a single Null table whose three MVs each carry a
-- WHERE clause selecting their slice. That puts the raw/derived split in
-- a predicate that has to be correct in three places, and the failure
-- mode is silent: a derived event that slips past a filter lands in
-- `analytics_raw` and inflates every projection built on it. Routing at
-- INSERT time instead means the sink picks the table, each MV stays
-- unfiltered, and a routing bug is visible as rows in the wrong table
-- rather than as quietly wrong counts.
--
-- ## Why derived events are not just more rows in analytics_raw
--
-- They are a different kind of fact. A source event is something a
-- producer observed; a derived event is something Polaris concluded, and
-- it carries the concluding processor in `source.id` plus its own
-- `properties` schema. Mixing them would make `count()` on
-- `analytics_raw` ambiguous — every geoip enrichment would inflate the
-- event count for a session that produced exactly one page view — and
-- every existing projection MV would need a processor exclusion it does
-- not have today.
--
-- Column shape is identical to `analytics_events_queue` on purpose: the
-- sink builds one row type for both paths and chooses the destination
-- table, so there is no second projection function to keep in sync.
--
-- Stream families: reads from the shared derived families. Per-project
-- isolation (`session.events.<project_id>`) is handled at the
-- shared-transport resolver layer; an isolated project is an extra family
-- the sink subscribes to, not a second table here.

CREATE TABLE IF NOT EXISTS polaris.analytics_processed_queue ON CLUSTER '{cluster}'
(
    -- Envelope fields. Mirror the canonical event envelope defined in
    -- docs/architecture/01-event-contract.md. Derived events use the same
    -- envelope as source events — that is what makes one row type work
    -- for both ingestion paths.
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
    consent           String    DEFAULT '',    -- JSON object (informational in v1)
    privacy           String    DEFAULT '',    -- JSON object (informational in v1)
    properties        String    DEFAULT '',    -- JSON object

    -- Processor metadata. On this table it is never incidental: it names
    -- the processor that concluded the fact, so it is the column an
    -- operator filters by when a processor version misbehaves.
    processor_name    LowCardinality(String),
    processor_version LowCardinality(String),
    _version          UInt64    DEFAULT 0,

    -- Transport lineage, stamped by clickhouse-sink.
    --   _topic      concrete partition stream, e.g. `session.events-1`
    --   _partition  partition index within the super stream
    --   _offset     RabbitMQ stream offset of the message
    --
    -- `_topic` is also how a query recovers the stream family without a
    -- dedicated column: the family is the prefix before the final `-`.
    _topic            LowCardinality(String) DEFAULT '',
    _partition        UInt16    DEFAULT 0,
    _offset           UInt64    DEFAULT 0
)
-- Null: rows are dropped on write and only reach the materialized view.
ENGINE = Null;

-- IMPORTANT: never SELECT from this table. A Null engine returns nothing
-- by construction, so a SELECT during an incident reads as "no derived
-- events ingested". 33_mv_processed_queue_to_processed.sql is the only
-- sanctioned reader.
