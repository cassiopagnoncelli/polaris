-- migrate:up
--
-- Create the `identity_links` table.
--
-- Polaris's canonical identity graph is built by `sync/legacy/identity-resolver/v1/`.
-- Per `docs/architecture/05-processors-and-replay.md` § "Identity Resolution",
-- the canonical graph is an explicit-link graph: rows here represent
-- authoritative links between two identifiers (e.g. `anonymous_id + customer_id`
-- co-occurring in the same event). The shape is intentionally **extensible** so
-- new heuristic rules can land without schema migrations — see
-- `docs/implementation/tasks/P8-002-identity-resolver-v1.md` § "Storage shape".
--
-- Hard architectural rules baked into the schema:
--
--   - `evidence_type` is **open vocabulary**, not a Postgres enum. A new
--     heuristic rule lands by inserting rows with a new `evidence_type` value
--     plus code that interprets it. No migration is required. The Postgres
--     `text` column is intentional — it stays open by design.
--
--   - `evidence` is `jsonb` so each `evidence_type` defines its own shape.
--     A small registry in code (`sync/legacy/identity-resolver/v1/src/evidence.ts`)
--     documents the expected shape per type.
--
--   - `confidence` is a closed enum-shaped CHECK because the *vocabulary* of
--     link quality is stable. v1 emits only `authoritative` from the
--     explicit-overlap rule; future heuristic processors will emit
--     `candidate`. A view used by the default identity resolver returns
--     authoritative only — see `docs/implementation/tasks/P8-002-...` §
--     "Storage shape (extensible)".
--
--   - `processor_runs.run_id` is referenced via `run_id` (text). The link
--     attribution to a specific run is informational; if the run row is
--     deleted, the link must NOT be deleted (audit trail). The FK is therefore
--     ON DELETE SET NULL.
--
-- Schema reference:
--   docs/implementation/tasks/P8-002-identity-resolver-v1.md § "Storage shape"
--   docs/architecture/05-processors-and-replay.md § "Identity Resolution"

CREATE TABLE identity_links (
  -- UUIDv7 of the link row. Application-generated (`uuidv7()`); the column is
  -- `text` because Polaris does not install pgcrypto / uuid-ossp — see
  -- `db/migrations/20260512000001_bootstrap.sql`.
  link_id             text        PRIMARY KEY,
  -- Project scope. Identity graphs are project-bounded in v1 — cross-project
  -- linking is intentionally not supported.
  project_id          text        NOT NULL REFERENCES projects(project_id),
  -- Environment scope. Closed set, mirrors the `processor_runs.environment`
  -- CHECK constraint.
  environment         text        NOT NULL,
  -- Identifiers in `<kind>:<value>` form. Encoding both halves in one column
  -- keeps graph traversal queries cheap without a dedicated `kind` column.
  -- Convention: the alphabetically-smaller `kind` is placed left so any
  -- (left, right) pair has exactly one canonical orientation.
  left_identifier     text        NOT NULL,
  right_identifier    text        NOT NULL,
  -- Link-quality marker. v1 emits only `authoritative`; `candidate` is
  -- reserved for future heuristic processors.
  confidence          text        NOT NULL,
  -- Open vocabulary. New rules add new values here without migrations.
  evidence_type       text        NOT NULL,
  -- Heuristic-specific data; shape is per-`evidence_type`. The processor
  -- code registry (`evidence.ts`) documents expected shapes.
  evidence            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Human-readable explanation captured at insert time. Used for operator
  -- triage; processors must NOT depend on this field semantically.
  reason              text        NOT NULL,
  -- Processor that emitted the link. The (name, version) tuple matches the
  -- on-disk processor directory and the manifest.
  processor_name      text        NOT NULL,
  processor_version   text        NOT NULL,
  -- Run that recorded the link. References `processor_runs(run_id)`. If the
  -- run row is later deleted, the link remains for audit purposes — the
  -- column goes NULL instead of cascading.
  run_id              text        REFERENCES processor_runs(run_id) ON DELETE SET NULL,
  -- Insertion time.
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Retirement marker. NULL while the link is active. When a heuristic
  -- promotion or operator-driven correction supersedes the row, set this
  -- column rather than deleting. Audit trail stays intact.
  superseded_at       timestamptz,

  CONSTRAINT identity_links_link_id_nonempty
    CHECK (length(link_id) >= 1 AND length(link_id) <= 64),
  CONSTRAINT identity_links_left_identifier_format
    CHECK (left_identifier ~ '^[a-z][a-z0-9_]*:.{1,}$' AND length(left_identifier) <= 256),
  CONSTRAINT identity_links_right_identifier_format
    CHECK (right_identifier ~ '^[a-z][a-z0-9_]*:.{1,}$' AND length(right_identifier) <= 256),
  CONSTRAINT identity_links_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT identity_links_confidence_allowed
    CHECK (confidence IN ('authoritative', 'candidate')),
  CONSTRAINT identity_links_evidence_type_format
    CHECK (evidence_type ~ '^[a-z][a-z0-9_]*$' AND length(evidence_type) <= 64),
  CONSTRAINT identity_links_reason_length
    CHECK (length(reason) >= 1 AND length(reason) <= 2048),
  CONSTRAINT identity_links_processor_name_format
    CHECK (processor_name ~ '^[a-z][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT identity_links_processor_version_format
    CHECK (processor_version ~ '^v[0-9]+(\.[0-9]+){0,2}$'),
  -- Left and right must differ — a link from an identifier to itself is
  -- semantically empty.
  CONSTRAINT identity_links_distinct_identifiers
    CHECK (left_identifier <> right_identifier),
  -- Superseded rows must have a `superseded_at` strictly after `created_at`.
  CONSTRAINT identity_links_superseded_after_created
    CHECK (superseded_at IS NULL OR superseded_at >= created_at)
);

-- Graph traversal: "what identifiers are linked to this one?". Two indexes
-- because the resolver looks up by either side. The default identity view
-- (active authoritative links) is the hot path; the indexes are partial on
-- `superseded_at IS NULL` to keep them tight.
CREATE INDEX identity_links_left_active_idx
  ON identity_links (project_id, environment, left_identifier)
  WHERE superseded_at IS NULL;
CREATE INDEX identity_links_right_active_idx
  ON identity_links (project_id, environment, right_identifier)
  WHERE superseded_at IS NULL;

-- Operator/audit path: "show recent links for this processor version".
CREATE INDEX identity_links_processor_created_idx
  ON identity_links (processor_name, processor_version, created_at DESC);

-- Idempotency support for the resolver: looking up an existing
-- (left, right, evidence_type) active link before inserting a new row.
CREATE UNIQUE INDEX identity_links_active_pair_idx
  ON identity_links (
    project_id,
    environment,
    left_identifier,
    right_identifier,
    evidence_type
  )
  WHERE superseded_at IS NULL;

-- migrate:down

DROP TABLE identity_links;
