-- migrate:up
--
-- Create the `delivery_records` table.
--
-- Per `docs/architecture/06-destinations.md`, destination consumers run a
-- three-stage pipeline (normalize -> map -> deliver) and write a delivery
-- record per outcome. This table owns those records.
--
-- One row per delivery attempt per envelope per destination. Attempts are
-- numbered from 1; a retried attempt produces a NEW row (so the table is
-- a complete attempt history rather than a "current state" view). Operators
-- read the table to triage DLQ traffic, correlate downstream vendor issues
-- to specific events, and audit replay-induced redeliveries.
--
-- Hard architectural rules baked into the schema:
--
--   - **No resolved secret values.** The destination row stores a `secret_ref`
--     (`provider:ref` form); the runtime resolves it through
--     `@polaris/shared-secrets` only at delivery time, in memory, and the
--     plaintext NEVER lands in this table. The schema has NO column
--     resembling `secret`, `token`, `bearer`, `credential`, `plaintext`,
--     `authorization`, `api_key`, or `private_key`.
--
--   - **No full vendor response bodies.** Vendor responses may include the
--     identity tuple we sent and other potentially sensitive payload echos.
--     The schema only carries a short `vendor_response_summary` (truncated
--     to 1 KB at the application layer) and a `vendor_response_code` (HTTP
--     status or vendor-specific status code). Full response bodies belong
--     in ephemeral logs (Loki), not in this durable record.
--
--   - **No event payload echo.** The original envelope's `properties` are
--     NOT copied here. Replay correlation uses `event_id`; the original
--     event lives in `raw.events` / `analytics.events` for the operational
--     retention window.
--
--   - **Closed-set status / error_class.** The CHECK constraints below pin
--     the closed sets the runtime emits. New variants land through a
--     migration that widens both columns AND the typed
--     `DeliveryRecordStatus` / `DeliveryRecordErrorClass` union types in
--     `packages/shared-destinations/src/db/delivery-records.ts`.
--
-- See:
--   - docs/architecture/06-destinations.md "Delivery Model" / "Retry and DLQ Policy"
--   - docs/architecture/05-processors-and-replay.md (parallel processor_runs design)
--   - docs/implementation/tasks/P9-001-destination-consumer-runtime.md

CREATE TABLE delivery_records (
  -- Platform-issued UUIDv7. text column to match the existing convention
  -- (Polaris does not use pgcrypto / uuid-ossp; see
  -- `db/migrations/20260512000001_bootstrap.sql`).
  delivery_id              text        PRIMARY KEY,

  -- FK to the destination instance the runtime read at attempt time.
  destination_id           text        NOT NULL REFERENCES destinations(destination_id),

  -- Original envelope event_id, kept as text for replay correlation. The
  -- canonical envelope's event_id is UUIDv7; the column stays free-form
  -- so this table can also record deliveries triggered by replay tooling
  -- against archived events that pre-date UUIDv7.
  event_id                 text        NOT NULL,

  -- Optional canonical event name and project / environment, copied off
  -- the envelope at attempt time so operators can filter the table without
  -- joining back to raw.events. These columns are INFORMATIONAL — the
  -- authoritative envelope still lives in Redpanda.
  event_name               text        NOT NULL,
  project_id               text        NOT NULL REFERENCES projects(project_id),
  environment              text        NOT NULL,

  -- Stage versions. Each stage is independently versioned per
  -- `docs/architecture/06-destinations.md` ("Three Stages"). Stamping them
  -- on every delivery record makes a `normalize/v1 -> normalize/v2`
  -- transition auditable: queries can scope to "all records produced with
  -- normalize/v2 against deliverer/v1".
  consumer_version         text        NOT NULL,
  normalize_version        text        NOT NULL,
  mapper_version           text        NOT NULL,
  deliverer_version        text        NOT NULL,

  -- 1-based attempt counter. A successful first attempt has attempt=1.
  -- Retries produce a NEW row with attempt=N+1; the runtime carries the
  -- attempt counter through retry topic headers (`polaris-retry-attempts`).
  attempt                  integer     NOT NULL,

  -- Closed-set outcome status. Mirrors the
  -- `DeliveryRecordStatus` union in
  -- `packages/shared-destinations/src/db/delivery-records.ts`.
  --
  --   accepted              successful 2xx-equivalent delivery
  --   dropped_consent       normalize stage gated on consent
  --   dropped_no_identity   normalize stage dropped (no usable identity)
  --   dropped_invalid       normalize stage dropped (invalid envelope /
  --                         redacted-empty payload)
  --   mapped_failed         mapper threw (mapping bug, missing required
  --                         vendor field, etc.)
  --   delivered             alias for `accepted`; reserved for vendor-
  --                         protocol "delivered" semantics distinct from
  --                         "accepted" (Meta CAPI returns 200 even for
  --                         events that are not deliverable downstream).
  --                         v1 emits `accepted`; `delivered` is reserved
  --                         for future vendor signal.
  --   failed_retryable      transient vendor / network failure; the
  --                         runtime republishes to `<vendor>.retry`.
  --   failed_permanent      4xx / auth failure / contract violation; the
  --                         runtime republishes to `<vendor>.dlq`.
  status                   text        NOT NULL,

  -- Closed-set error class label used for metrics and DLQ headers. NULL
  -- on success rows (`accepted` / `delivered`) so operator filters can
  -- distinguish a successful attempt from a failure with no classified
  -- cause.
  --
  --   consent      consent gating drop
  --   identity     no usable identity drop
  --   mapping      mapper threw
  --   auth         vendor auth failure (token expired / revoked)
  --   rate_limit   vendor rate-limit response (HTTP 429 etc.)
  --   transient    transient broker / network failure
  --   permanent    vendor reported permanent failure (4xx contract)
  --   timeout      delivery timed out
  --   policy       defensive second-pass redaction rejected the event
  error_class              text,

  -- Vendor's transport-level response code, when applicable. For HTTP-
  -- backed deliveries this is the status code (e.g. "202", "429"). For
  -- vendor-SDK deliveries this is the vendor-specific status code or the
  -- empty string. NULL when delivery never reached the network (dropped /
  -- mapper failure).
  vendor_response_code     text,

  -- Truncated vendor response summary. The application layer truncates
  -- to 1 KB before writing. NEVER carries the original event payload echo
  -- or resolved secrets. NULL when the runtime did not have a response to
  -- summarize (e.g. mapper threw before any network call).
  vendor_response_summary  text,

  -- Vendor-side dedupe key (Meta `event_id`, GA4 `transaction_id`, etc.).
  -- Same shape as `event_id` per architecture. NULL when the vendor has
  -- no dedupe protocol. Indexed for the "did we already deliver this
  -- key?" lookup the runtime runs before sending.
  dedupe_key               text,

  -- Wall-clock timestamps. `started_at` is when the runtime began the
  -- attempt (post-normalize, pre-deliver). `finished_at` is when the
  -- runtime decided the row's terminal status. NULL on `started_at`
  -- would be a programmer error.
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz NOT NULL DEFAULT now(),

  -- Required: every row records WHICH attempt of the underlying delivery
  -- it represents. The runtime stamps `attempt = readRetryAttempts(...)
  -- + 1` so the column is consistent with the retry-headers convention.
  CONSTRAINT delivery_records_delivery_id_nonempty
    CHECK (length(delivery_id) >= 1 AND length(delivery_id) <= 64),
  CONSTRAINT delivery_records_event_id_nonempty
    CHECK (length(event_id) >= 1 AND length(event_id) <= 128),
  CONSTRAINT delivery_records_event_name_format
    CHECK (event_name ~ '^[a-z][a-z0-9_.]*$'),
  CONSTRAINT delivery_records_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT delivery_records_attempt_positive
    CHECK (attempt >= 1 AND attempt <= 10000),
  CONSTRAINT delivery_records_consumer_version_format
    CHECK (consumer_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT delivery_records_normalize_version_format
    CHECK (normalize_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT delivery_records_mapper_version_format
    CHECK (mapper_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT delivery_records_deliverer_version_format
    CHECK (deliverer_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT delivery_records_status_allowed
    CHECK (status IN (
      'accepted',
      'delivered',
      'dropped_consent',
      'dropped_no_identity',
      'dropped_invalid',
      'mapped_failed',
      'failed_retryable',
      'failed_permanent'
    )),
  CONSTRAINT delivery_records_error_class_allowed
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
  CONSTRAINT delivery_records_vendor_response_summary_length
    CHECK (vendor_response_summary IS NULL OR length(vendor_response_summary) <= 1024),
  CONSTRAINT delivery_records_vendor_response_code_length
    CHECK (vendor_response_code IS NULL OR length(vendor_response_code) <= 64),
  CONSTRAINT delivery_records_dedupe_key_length
    CHECK (dedupe_key IS NULL OR length(dedupe_key) <= 128),
  CONSTRAINT delivery_records_finished_after_started
    CHECK (finished_at >= started_at)
);

-- Triage path: "show me the most recent deliveries for this destination"
-- (used by the future `polaris destinations records list` command).
CREATE INDEX delivery_records_destination_finished_idx
  ON delivery_records (destination_id, finished_at DESC);

-- "What failed recently across all destinations?" path.
CREATE INDEX delivery_records_status_finished_idx
  ON delivery_records (status, finished_at DESC);

-- Replay correlation: given an envelope event_id, find every delivery
-- attempt across every destination.
CREATE INDEX delivery_records_event_id_idx
  ON delivery_records (event_id);

-- Vendor dedupe lookup: "have we already delivered with this dedupe key?"
-- Partial index because dedupe_key is NULL for many vendors.
CREATE INDEX delivery_records_dedupe_key_idx
  ON delivery_records (destination_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS delivery_records_dedupe_key_idx;
DROP INDEX IF EXISTS delivery_records_event_id_idx;
DROP INDEX IF EXISTS delivery_records_status_finished_idx;
DROP INDEX IF EXISTS delivery_records_destination_finished_idx;
DROP TABLE IF EXISTS delivery_records;
