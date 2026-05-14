-- migrate:up
--
-- Create the `dlq_records` table.
--
-- Per `docs/architecture/06-destinations.md` "Retry and DLQ Policy", every
-- destination consumer owns a DLQ topic (`<vendor>.<version>.dlq`) where
-- the runtime republishes events the deliverer classified as
-- `failed_permanent` (or `failed_retryable` past the attempt budget).
--
-- The DLQ topics are useful for streaming consumers but operators triage
-- by row — "show me everything in the queue for Meta CAPI right now, let
-- me retry a specific event, mark another resolved with a note". The
-- topic-only design forces operators to spin up a Kafka client per
-- inspection; this table makes the queue queryable from `polaris dlq
-- list` / `show` / `retry` / `mark-resolved` against a single PostgreSQL
-- connection.
--
-- One row per Kafka DLQ message. The destination runtime writes a row
-- whenever it calls `publishToDestinationDlq` (P9-007 wires the runtime;
-- before P9-007 the table exists but stays empty). The row carries the
-- raw Kafka message value + headers so a retry can republish the
-- byte-identical envelope back onto `analytics.events`.
--
-- Hard architectural rules baked into the schema:
--
--   - **No resolved secret values.** Same posture as `delivery_records`.
--     The destination instance stores a `secret_ref`; the runtime never
--     stamps the resolved plaintext anywhere durable. The schema has NO
--     column resembling `secret`, `token`, `bearer`, `credential`,
--     `plaintext`, `authorization`, `api_key`, or `private_key`.
--
--   - **Triage state lives here, not on `delivery_records`.** A delivery
--     record is an immutable per-attempt log line. A DLQ record carries
--     mutable `resolved_at` / `resolved_by` / `resolution_note` slots so
--     operators can mark a queue entry done without rewriting history.
--
--   - **Closed-set error_class mirrors `delivery_records`.** The CHECK
--     constraint stays in lock-step with the equivalent constraint on
--     `delivery_records`; widening one requires widening both.
--
-- See:
--   - docs/architecture/06-destinations.md "Retry and DLQ Policy"
--   - docs/implementation/tasks/P9-007-destination-dlq-triage.md

CREATE TABLE dlq_records (
  -- Platform-issued UUIDv7. Same convention as `delivery_records`.
  dlq_id                   text        PRIMARY KEY,

  -- FK to the destination instance the runtime read at publish time.
  destination_id           text        NOT NULL REFERENCES destinations(destination_id),

  -- Original envelope event_id, copied off the canonical envelope at
  -- publish time. Free-form text (matches `delivery_records.event_id`)
  -- so replayed archived events without UUIDv7 ids land cleanly.
  event_id                 text        NOT NULL,

  -- Canonical event name + project / environment, copied off the
  -- envelope. Informational only; the authoritative envelope is the
  -- `value` bytes column below.
  event_name               text        NOT NULL,
  project_id               text        NOT NULL REFERENCES projects(project_id),
  environment              text        NOT NULL,

  -- Static descriptor identity at publish time. Stamping all four
  -- versions lets operators triage "all DLQ entries produced under
  -- mapper/v1 against deliverer/v2".
  vendor                   text        NOT NULL,
  consumer_version         text        NOT NULL,
  normalize_version        text        NOT NULL,
  mapper_version           text        NOT NULL,
  deliverer_version        text        NOT NULL,

  -- Attempt counter the runtime had when it published to the DLQ. 0 for
  -- decode-failure rows (the runtime never resolved an instance).
  attempts                 integer     NOT NULL,

  -- Free-form classification reason set by `publishToDestinationDlq`.
  -- Examples: `decode_failed`, `missing_destination_id`, `permanent`,
  -- `auth`, `mapping`. Bounded length for label safety.
  reason                   text        NOT NULL,

  -- Closed-set error class label. Matches the same set used by
  -- `delivery_records.error_class`. NULL on early-stage failures
  -- (decode / header errors).
  error_class              text,

  -- Last vendor response code / summary, when applicable. NULL when
  -- the runtime did not have a vendor response (decode failure, mapper
  -- threw, etc.).
  vendor_response_code     text,
  vendor_response_summary  text,

  -- Stable delivery key the runtime stamped on the DLQ message. NULL
  -- when the runtime never resolved a delivery key (decode failure
  -- before the instance lookup).
  delivery_key             text,

  -- Source Kafka coordinates so operators can correlate a DLQ row back
  -- to a topic / partition / offset for forensic replay.
  source_topic             text        NOT NULL,
  source_partition         integer     NOT NULL,
  source_offset            text        NOT NULL,

  -- Kafka message headers at publish time. JSONB so operators can
  -- filter by header values (`polaris-destination-vendor`, etc.).
  headers                  jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Raw Kafka message value bytes. The byte-identical envelope so a
  -- retry can republish exactly what the destination consumer would
  -- have seen the first time.
  payload                  bytea,

  -- Wall-clock timestamps. `published_at` is when the runtime
  -- DLQ-published; `resolved_at` is set when an operator marks the row
  -- resolved (via retry or mark-resolved). `resolved_by` carries the
  -- audit actor label.
  published_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at              timestamptz,
  resolved_by              text,
  resolution_note          text,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dlq_records_dlq_id_format
    CHECK (length(dlq_id) >= 1 AND length(dlq_id) <= 64),
  CONSTRAINT dlq_records_event_id_nonempty
    CHECK (length(event_id) >= 1 AND length(event_id) <= 128),
  CONSTRAINT dlq_records_event_name_format
    CHECK (event_name ~ '^[a-z][a-z0-9_.*]*$'),
  CONSTRAINT dlq_records_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT dlq_records_attempts_nonnegative
    CHECK (attempts >= 0 AND attempts <= 10000),
  CONSTRAINT dlq_records_consumer_version_format
    CHECK (consumer_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT dlq_records_normalize_version_format
    CHECK (normalize_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT dlq_records_mapper_version_format
    CHECK (mapper_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT dlq_records_deliverer_version_format
    CHECK (deliverer_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT dlq_records_reason_length
    CHECK (length(reason) >= 1 AND length(reason) <= 64),
  CONSTRAINT dlq_records_error_class_allowed
    CHECK (error_class IS NULL OR error_class IN (
      'consent',
      'identity',
      'mapping',
      'auth',
      'rate_limit',
      'transient',
      'permanent',
      'timeout',
      'policy'
    )),
  CONSTRAINT dlq_records_vendor_response_summary_length
    CHECK (vendor_response_summary IS NULL OR length(vendor_response_summary) <= 1024),
  CONSTRAINT dlq_records_vendor_response_code_length
    CHECK (vendor_response_code IS NULL OR length(vendor_response_code) <= 64),
  CONSTRAINT dlq_records_delivery_key_length
    CHECK (delivery_key IS NULL OR length(delivery_key) <= 128),
  CONSTRAINT dlq_records_source_topic_length
    CHECK (length(source_topic) >= 1 AND length(source_topic) <= 255),
  CONSTRAINT dlq_records_source_partition_nonnegative
    CHECK (source_partition >= 0),
  CONSTRAINT dlq_records_source_offset_length
    CHECK (length(source_offset) >= 1 AND length(source_offset) <= 64),
  CONSTRAINT dlq_records_resolved_consistent
    CHECK (
      (resolved_at IS NULL AND resolved_by IS NULL) OR
      (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    ),
  CONSTRAINT dlq_records_resolved_by_length
    CHECK (resolved_by IS NULL OR (length(resolved_by) >= 1 AND length(resolved_by) <= 128)),
  CONSTRAINT dlq_records_resolution_note_length
    CHECK (resolution_note IS NULL OR length(resolution_note) <= 1024)
);

-- Active triage queue: "what's currently unresolved for this destination?"
CREATE INDEX dlq_records_destination_unresolved_idx
  ON dlq_records (destination_id, published_at DESC)
  WHERE resolved_at IS NULL;

-- "What's unresolved across this vendor right now?"
CREATE INDEX dlq_records_vendor_unresolved_idx
  ON dlq_records (vendor, published_at DESC)
  WHERE resolved_at IS NULL;

-- Replay correlation: given an envelope event_id, find every DLQ row.
CREATE INDEX dlq_records_event_id_idx
  ON dlq_records (event_id);

-- Per-destination history (resolved + unresolved) for forensic queries.
CREATE INDEX dlq_records_destination_published_idx
  ON dlq_records (destination_id, published_at DESC);

-- migrate:down

DROP INDEX IF EXISTS dlq_records_destination_published_idx;
DROP INDEX IF EXISTS dlq_records_event_id_idx;
DROP INDEX IF EXISTS dlq_records_vendor_unresolved_idx;
DROP INDEX IF EXISTS dlq_records_destination_unresolved_idx;
DROP TABLE IF EXISTS dlq_records;
