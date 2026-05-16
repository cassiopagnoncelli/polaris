-- migrate:up
--
-- 3L2HKMND: Create the `processor_dlq_records` table.
--
-- Per `docs/architecture/03-redpanda-topics.md` "Retry and DLQ
-- Topics", each Polaris processor (analytics-projector,
-- identity-resolver, sessionizer, geoip-enricher,
-- attribution-engine) owns a DLQ topic (`<processor>.dlq`) where
-- the runtime republishes messages it cannot retry or has retried
-- to exhaustion. The DLQ topics are useful for stream consumers
-- but operators triage by row: "show me everything in flight for
-- the geoip-enricher, retry this one, mark that one resolved with
-- a note." The topic-only design forces operators to spin up a
-- Kafka client per inspection; this table makes the queue
-- queryable from `polaris processors dlq list / show / retry /
-- mark-resolved` against a single PostgreSQL connection.
--
-- Structural mirror of `dlq_records` (the destination DLQ surface
-- shipped in P9-007 + the `dlq_records` migration above), simplified
-- for the processor side:
--
--   - `processor_name` + `processor_version` replace the
--     destination identity tuple (vendor / consumer / normalize /
--     mapper / deliverer versions). Processors carry only a single
--     semantic-version axis.
--   - `error_class` and `error_message` are free-form text (the
--     processor classifier emits a `reason` string like
--     `decode_failed` / `unknown_error` per `packages/shared-processor/
--     src/classify.ts`, not the closed-set destination enum).
--   - `payload` and `headers` carry the byte-identical original
--     message so a retry can republish exactly what the processor
--     handler would have seen the first time.
--
-- Hard architectural rules baked into the schema:
--
--   - **Triage state lives here, not on processor_runs.** A
--     `processor_runs` row is an immutable per-message log line; a
--     `processor_dlq_records` row carries mutable `resolved_*`
--     slots so operators can mark a queue entry done without
--     rewriting history.
--
--   - **Dual-write transition window.** The processor runtime
--     keeps publishing to the Kafka DLQ topic and ALSO writes a
--     row here. Grafana panels and existing runbooks that consume
--     the topic stay unbroken while the new query path beds in.
--
-- See:
--   - docs/architecture/03-redpanda-topics.md "Retry and DLQ Topics"
--   - docs/operations/dlq-triage-runbook.md (updated alongside this card)

CREATE TABLE processor_dlq_records (
  dlq_id                  text        PRIMARY KEY,

  -- Processor identity at publish time. The pair narrows the row to
  -- one (processor, version) pipeline; an operator triaging "what's
  -- broken in the geoip-enricher across v1 + v2" filters by name.
  processor_name          text        NOT NULL,
  processor_version       text        NOT NULL,

  -- Original envelope coordinates. `event_id` mirrors the canonical
  -- envelope's id; `event_name` is the canonical event name so the
  -- triage UI can group by event. `project_id` + `environment`
  -- narrow to a single tenant.
  event_id                text        NOT NULL,
  event_name              text        NOT NULL,
  project_id              text        NOT NULL REFERENCES projects(project_id),
  environment             text        NOT NULL,

  -- Attempt counter the runtime had when it published to the DLQ.
  -- 0 for decode-failure rows that never entered the handler loop.
  attempts                integer     NOT NULL,

  -- Free-form classification reason set by `publishToDlq`. Examples
  -- from `classifyError`: `decode_failed`, `validation_failed`,
  -- `unknown_error`. Bounded length for label safety.
  reason                  text        NOT NULL,

  -- Free-form error class and message. The classifier emits
  -- `error.name` and `error.message` straight through; both are
  -- nullable for cases where the runtime DLQ-routed a message
  -- without a JS Error (e.g. decode failure with a custom code).
  error_class             text,
  error_message           text,

  -- Source Kafka coordinates so operators can correlate a DLQ row
  -- back to a topic / partition / offset for forensic replay.
  source_topic            text        NOT NULL,
  source_partition        integer     NOT NULL,
  source_offset           text        NOT NULL,

  -- Kafka message headers at publish time. JSONB so operators can
  -- filter by header values without parsing.
  headers                 jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Raw Kafka message value bytes. The byte-identical envelope so a
  -- retry can republish exactly what the processor handler would
  -- have seen the first time.
  payload                 bytea,

  -- Wall-clock timestamps. `published_at` is when the runtime
  -- DLQ-published; `resolved_at` is set when an operator marks the
  -- row resolved (via retry or mark-resolved). `resolved_by`
  -- carries the audit actor label.
  published_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  resolved_by             text,
  resolution_note         text,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT processor_dlq_records_dlq_id_format
    CHECK (length(dlq_id) >= 1 AND length(dlq_id) <= 64),
  CONSTRAINT processor_dlq_records_processor_name_format
    CHECK (processor_name ~ '^[a-z][a-z0-9-]*$'),
  CONSTRAINT processor_dlq_records_processor_version_format
    CHECK (processor_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT processor_dlq_records_event_id_nonempty
    CHECK (length(event_id) >= 1 AND length(event_id) <= 128),
  CONSTRAINT processor_dlq_records_event_name_format
    CHECK (event_name ~ '^[a-z][a-z0-9_.*]*$'),
  CONSTRAINT processor_dlq_records_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT processor_dlq_records_attempts_nonnegative
    CHECK (attempts >= 0 AND attempts <= 10000),
  CONSTRAINT processor_dlq_records_reason_length
    CHECK (length(reason) >= 1 AND length(reason) <= 64),
  CONSTRAINT processor_dlq_records_error_class_length
    CHECK (error_class IS NULL OR length(error_class) <= 128),
  CONSTRAINT processor_dlq_records_error_message_length
    CHECK (error_message IS NULL OR length(error_message) <= 4096),
  CONSTRAINT processor_dlq_records_source_topic_length
    CHECK (length(source_topic) >= 1 AND length(source_topic) <= 255),
  CONSTRAINT processor_dlq_records_source_partition_nonnegative
    CHECK (source_partition >= 0),
  CONSTRAINT processor_dlq_records_source_offset_length
    CHECK (length(source_offset) >= 1 AND length(source_offset) <= 64),
  CONSTRAINT processor_dlq_records_resolved_consistent
    CHECK (
      (resolved_at IS NULL AND resolved_by IS NULL) OR
      (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    ),
  CONSTRAINT processor_dlq_records_resolved_by_length
    CHECK (resolved_by IS NULL OR (length(resolved_by) >= 1 AND length(resolved_by) <= 128)),
  CONSTRAINT processor_dlq_records_resolution_note_length
    CHECK (resolution_note IS NULL OR length(resolution_note) <= 1024)
);

-- Active triage queue: "what's currently unresolved for this processor?"
CREATE INDEX processor_dlq_records_processor_unresolved_idx
  ON processor_dlq_records (processor_name, published_at DESC)
  WHERE resolved_at IS NULL;

-- Replay correlation: given an envelope event_id, find every DLQ row.
CREATE INDEX processor_dlq_records_event_id_idx
  ON processor_dlq_records (event_id);

-- Per-processor history (resolved + unresolved) for forensic queries.
CREATE INDEX processor_dlq_records_processor_published_idx
  ON processor_dlq_records (processor_name, published_at DESC);

-- migrate:down

DROP INDEX IF EXISTS processor_dlq_records_processor_published_idx;
DROP INDEX IF EXISTS processor_dlq_records_event_id_idx;
DROP INDEX IF EXISTS processor_dlq_records_processor_unresolved_idx;
DROP TABLE IF EXISTS processor_dlq_records;
