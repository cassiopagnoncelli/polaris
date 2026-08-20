-- migrate:up
--
-- Per-project secrets move from provider REFERENCES to plaintext VALUES.
--
-- Until now the platform rule was "PostgreSQL stores references, never
-- plaintext": a secret lived in Vault (or the process environment) and the
-- database held a `provider:ref` pointer that `@polaris/runtime-secrets`
-- resolved per use. The rule now splits in two:
--
--   - APP / DEPLOYMENT secrets (the Postgres DSN, the broker password, the
--     ClickHouse credentials) are unchanged. They are not per-project, they
--     are read at bootstrap from the environment, and they never appear in
--     either table below.
--
--   - PER-PROJECT secrets — a project's own variables and its destination
--     credentials — are stored here, in this database, as plaintext.
--
-- What this buys: one storage mechanism for everything a project declares,
-- editable from the admin UI, with no external dependency in the read path.
-- What it costs, stated plainly so nobody rediscovers it during an incident:
-- every reader of this database, every `pg_dump`, every replica and every
-- backup now carries live credentials. Access to the control-plane database
-- IS access to every project's vendor accounts.
--
-- `is_secret` / masking is what survives of the old model. It no longer means
-- "this is a pointer to resolve"; it means "this is sensitive": the value is
-- boxed in `Secret<T>` on read, redacted in logs, audit snapshots, delivery
-- records, DLQ payloads and exports, and masked in the admin UI behind an
-- explicit reveal. Storage changed; handling did not.
--
-- See:
--   - docs/implementation/project-config-plan.md "Secrets"
--   - docs/architecture/02-control-plane.md "Secrets"

-- ---------------------------------------------------------------------------
-- project_config: `is_secret_ref` (a pointer flag) -> `is_secret` (a
-- sensitivity flag).
-- ---------------------------------------------------------------------------

ALTER TABLE project_config
  DROP CONSTRAINT project_config_secret_ref_shape;

ALTER TABLE project_config
  RENAME COLUMN is_secret_ref TO is_secret;

-- Half the old constraint survives, and deliberately. The `provider:ref`
-- PATTERN is gone — a plaintext credential matches no pattern worth
-- asserting. The STRING requirement stays: masking, reveal and redaction
-- each have exactly one shape to handle, and a secret that needs structure
-- is a JSON-encoded string.
ALTER TABLE project_config
  ADD CONSTRAINT project_config_secret_is_string
    CHECK (NOT is_secret OR jsonb_typeof(value) = 'string');

-- ---------------------------------------------------------------------------
-- destinations: `secret_ref` -> `secret_value`.
-- ---------------------------------------------------------------------------
--
-- The rename is load-bearing, not cosmetic. Eight call sites logged, printed,
-- exported or audit-snapshotted this column BECAUSE its name promised a
-- pointer — the admin UI rendered it labelled "(pointer, not a secret)", and
-- the destination runtime stamped it onto every delivery log line. Under the
-- old name each of those would have silently become a credential disclosure.
-- Renaming makes the compiler visit all of them.

ALTER TABLE destinations
  DROP CONSTRAINT destinations_secret_ref_format;

ALTER TABLE destinations
  RENAME COLUMN secret_ref TO secret_value;

-- No format CHECK replaces the old one: a vendor credential is an opaque
-- string, and per-vendor shape (meta-capi wants a JSON object, ga4 wants an
-- api_secret) is the consumer's business, asserted in its `parseResolvedSecret`.
-- Non-empty is the one thing every vendor agrees on, and it catches the
-- `--secret-value ''` typo at the boundary rather than at delivery time.
ALTER TABLE destinations
  ADD CONSTRAINT destinations_secret_value_present
    CHECK (length(secret_value) > 0);

-- ---------------------------------------------------------------------------
-- Cutover note for rows written before this migration
-- ---------------------------------------------------------------------------
--
-- Existing `destinations` rows hold `provider:ref` pointers, and this
-- migration cannot resolve them — it has no Vault credentials and no business
-- holding them. Those rows survive the rename with a pointer sitting in a
-- column that now means "the credential itself", and an operator has to
-- re-enter the real value with `polaris destinations rotate-secret`.
--
-- Left loud rather than papered over: a pointer string fails every consumer's
-- secret parse (meta-capi wants `{pixel_id, access_token}` JSON, ga4 wants an
-- api_secret), so the delivery lands as `failed_permanent` with
-- `error_class='auth'` and a summary naming the destination. That is a visible
-- alert on the first event, not silent misdelivery.

-- migrate:down
--
-- Reversing is best-effort. Any secret written since the up-migration is
-- plaintext, and re-adding the `provider:ref` CHECKs will fail on it — which
-- is the correct behaviour: a down-migration must not silently keep
-- credentials in a column the rest of the system will treat as a public
-- pointer and print. Clear or re-point those rows first.

ALTER TABLE destinations
  DROP CONSTRAINT destinations_secret_value_present;

ALTER TABLE destinations
  RENAME COLUMN secret_value TO secret_ref;

ALTER TABLE destinations
  ADD CONSTRAINT destinations_secret_ref_format
    CHECK (secret_ref ~ '^[a-z][a-z0-9_-]*:[^[:space:]]+$');

ALTER TABLE project_config
  DROP CONSTRAINT project_config_secret_is_string;

ALTER TABLE project_config
  RENAME COLUMN is_secret TO is_secret_ref;

ALTER TABLE project_config
  ADD CONSTRAINT project_config_secret_ref_shape
    CHECK (
      NOT is_secret_ref
      OR (jsonb_typeof(value) = 'string'
          AND value #>> '{}' ~ '^[a-z][a-z0-9_-]*:[^[:space:]]+$')
    );
