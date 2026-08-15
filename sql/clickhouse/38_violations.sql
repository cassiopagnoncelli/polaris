-- Polaris schema-governance quarantine.
--
-- Fed from `rejected.events` by the ClickHouse sink. One row per event the
-- ingester refused: why, which field paths, and a sample with every policy
-- redaction already applied by the time it left the ingester.
--
-- ## Why this is a table and not a log line
--
-- Schema governance is three questions, and all three are aggregates:
--
--   - which projects are still sending a forbidden field?
--   - did a release start failing validation?
--   - is this rejection spike new, or is it Tuesday?
--
-- None of them is answerable by grepping logs across a fleet, and all
-- three are one GROUP BY here.
--
-- ## Retention is short and is the durable bound
--
-- 30 days. The broker's `rejected.events` keeps 7, which bounds how much
-- known-bad payload sits in a stream nothing replays; this bounds how long
-- the platform keeps it at all. A governance question older than a month
-- is answered by the fact that the violation stopped, not by the row.
--
-- The TTL is deliberately shorter than `analytics_raw`'s. These rows
-- describe payloads that violated policy — they are the highest-risk data
-- in the warehouse and the least useful after the producer has been told.
--
-- ## No dedupe engine
--
-- MergeTree, not ReplacingMergeTree. Two sightings of one violation are
-- two rejections and should count as two: a producer retrying a rejected
-- event IS sending it again, and a governance dashboard that collapsed the
-- retries would understate the volume it exists to measure. `violation_id`
-- is unique per rejection for exactly this reason — it is not the
-- producer's `event_id`.

CREATE TABLE IF NOT EXISTS polaris.violations ON CLUSTER '{cluster}'
(
    -- Platform-issued, unique per rejection. NOT the producer's event_id.
    violation_id        String,
    -- Wire-record version, so a reader can tell which shape it is looking
    -- at. Versioned independently of the event envelope; see
    -- packages/shared-schemas/src/violation.ts.
    violation_version   UInt16,

    -- From the API key tuple, never from the payload. A rejected event's
    -- self-reported project is exactly the kind of thing that may be wrong.
    project_id          LowCardinality(String),
    environment         LowCardinality(String),

    -- Producer-supplied HINTS. Empty when the payload never carried them
    -- or carried something that was not a string, which is itself a common
    -- rejection reason.
    event               LowCardinality(String),
    event_id            String,
    schema_version      Int32,

    -- Closed-set batch reason code. LowCardinality because there are ~10.
    reason              LowCardinality(String),

    -- Dotted field paths implicated in the rejection. Paths only, never
    -- values — the same discipline the batch response follows, and what
    -- makes "which projects still send `cvv`?" answerable without this
    -- table becoming a second copy of the data it exists to keep out.
    paths               Array(String),

    -- JSON, with every policy redaction applied before it was published.
    -- See packages/shared-policy/src/evaluator.ts (`buildViolationSample`).
    redacted_sample     String,

    received_at         DateTime64(3, 'UTC'),
    inserted_at         DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = {replicated}MergeTree
PARTITION BY toYYYYMM(received_at)
-- Ordered for the query the dashboards and the CLI actually run: scope
-- first, then reason, then time. `polaris violations list --project X
-- --since T` reads one contiguous range; a time-first key would scan every
-- project's rejections to answer a question about one.
ORDER BY (project_id, environment, reason, received_at)
TTL toDateTime(received_at) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- The ingestion interface table.
--
-- `Null` engine, like every other Polaris queue table: rows are handed to
-- the materialized view and never stored here. That is the convention, and
-- it matters more here than elsewhere — a MergeTree queue would keep a
-- SECOND copy of every redacted sample, outside the `violations` TTL, in a
-- table nobody would think to check when asked how long the platform
-- retains rejected payloads.
CREATE TABLE IF NOT EXISTS polaris.violations_queue ON CLUSTER '{cluster}'
(
    violation_id        String,
    violation_version   UInt16,
    project_id          String,
    environment         String,
    event               String,
    event_id            String,
    schema_version      Int32,
    reason              String,
    paths               Array(String),
    redacted_sample     String,
    received_at         String
)
ENGINE = Null;

CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.mv_violations_queue_to_violations
ON CLUSTER '{cluster}'
TO polaris.violations
AS
SELECT
    violation_id,
    violation_version,
    project_id,
    environment,
    event,
    event_id,
    schema_version,
    reason,
    paths,
    redacted_sample,
    -- `received_at` arrives as the ISO-8601 literal the ingester stamped.
    -- parseDateTime64BestEffort is what understands the `T` separator and
    -- the trailing `Z`; the sink sets date_time_input_format=best_effort
    -- for the same reason on the other queues.
    parseDateTime64BestEffortOrZero(received_at, 3, 'UTC') AS received_at
FROM polaris.violations_queue;
