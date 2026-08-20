-- Polaris ClickHouse: ingestion interface table for profile-plane events
--
-- Third sibling of 10_analytics_events_queue.sql and
-- 11_analytics_processed_queue.sql. Same transport boundary, same Null
-- engine, a different kind of fact again:
--
--   profile.events    profile.created, profile.updated, identity.merged
--
-- ## Why not analytics_processed
--
-- A derived event describes something that HAPPENED — a session started, a
-- touchpoint was captured. A `profile.updated` describes what is now TRUE
-- of a person. Both are things Polaris concluded, but only one of them is
-- current state, and that difference decides the engine downstream:
-- `analytics_processed` is a log that keeps every row, while `profiles`
-- collapses to the latest per person.
--
-- Putting them in one table would mean either keeping every trait revision
-- in the hot state table or collapsing genuine event history. The card's
-- criterion says "not analytics_processed" and this is why.
--
-- ## The stream IS the history
--
-- `profiles.traits` holds only the current value, because it is runtime
-- state on the hot path. The record of what a profile believed and when
-- lives HERE — every `profile.updated` row, changed keys only, forever
-- (subject to TTL). `profile.updated`'s catalog entry has claimed that
-- since it shipped; this table is what makes the claim true.
--
-- Column shape mirrors the other two queues on purpose: the sink builds one
-- row type for all three paths and chooses the destination table, so there
-- is no third projection function to keep in sync.

CREATE TABLE IF NOT EXISTS polaris.profile_events_queue ON CLUSTER '{cluster}'
(
    event_id          String,
    event             LowCardinality(String),
    schema_version    UInt32,
    project_id        LowCardinality(String),
    environment       LowCardinality(String),
    occurred_at       DateTime64(3, 'UTC'),
    ingested_at       DateTime64(3, 'UTC'),
    source_id         LowCardinality(String),
    source_type       LowCardinality(String),
    -- The profile this event is about. Lifted out of `properties` by the
    -- MV rather than read per query: every downstream read keys on it.
    profile_id        String,
    properties        String,
    _version          UInt64
)
ENGINE = Null;
