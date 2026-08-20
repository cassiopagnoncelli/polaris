-- migrate:up
--
-- Create the `destinations` table.
--
-- Destinations are runtime instances of vendor-adapter consumers (Meta CAPI,
-- GA4, TikTok, Braze, webhook-sink, reverse-etl). One row per deployed
-- destination instance per (project, environment). The row holds runtime and
-- operational knobs only — PostgreSQL never stores mapping semantics.
--
-- Mapping semantics (event-to-vendor field maps) live in code under
-- `consumers/<vendor>/v<n>/mappers/`. This is the central architectural rule
-- for P6-004: the CLI cannot define mappings, and the schema has no column
-- that would let it. Tests in `apps/polaris-cli/test/destinations-commands.test.ts`
-- assert the absence of mapping fields on both the schema and the typed
-- `DestinationsTable` interface.
--
-- See:
--   - docs/architecture/06-destinations.md "Destination Instances"
--   - docs/architecture/02-control-plane.md "Destinations"
--   - docs/implementation/tasks/P6-004-destination-instance-cli.md
--
-- Schema rules:
--   - `destination_id` is the platform-issued public id. Format is
--     `polaris_dst_<uuidv7>`, mirroring the `polaris_ak_` prefix for API
--     keys. The CHECK constraint pins the prefix.
--   - `(project_id, environment)` is indexed for the listing path.
--     Destinations route by event_name / property routing (see
--     06-destinations.md "Three Stages"); they do NOT bind to a specific
--     source, so there is no FK to `sources`.
--   - `instance_label` is operator-supplied (short label, e.g. "storefront-prod")
--     used in CLI output and audit records. Unique within a (project,
--     environment, vendor) tuple so operators can tell two Meta CAPI
--     destinations apart on the same project.
--   NOTE (added later, not a rewrite): `secret_ref` was renamed to
--   `secret_value` and now holds the credential ITSELF in plaintext. See
--   20260813000004_plaintext_project_secrets.sql. Everything the bullet below
--   says was true when this migration ran and is no longer.
--
--   - `secret_ref` is the provider-namespaced reference (e.g.
--     `env:META_CAPI_TOKEN_STOREFRONT_PROD` or
--     `secret_manager:polaris/production/storefront/meta-capi`). PostgreSQL
--     never stores the resolved value — the runtime resolves it through
--     `@polaris/runtime-secrets` at delivery time.
--   - `status` toggles instance availability (active | paused | disabled);
--     `mode` toggles delivery behavior (live | sandbox | test) and is a
--     non-semantic operational dial.
--   - Operational tuning columns (`max_concurrency`, `max_rps`,
--     `retry_policy`, `dead_letter_threshold`) are non-semantic; they tune
--     delivery and never alter event meaning.
--
-- Hard rule baked into the schema (narrowed 2026-08-13; see
-- docs/implementation/project-config-plan.md §2):
--   - PostgreSQL stores VALUES for configuration keys declared in component
--     code; it never stores mappings, routing, transforms, or field maps.
--     NO `field_map`, `mapping`, `event_map`, `target_field`, or similar
--     column, ever. The `config` column (added by
--     20260813000002_add_destinations_config.sql) carries consumer-
--     interpreted per-instance values such as pixel_id — parameters, not
--     semantics. The mapping prohibition is unchanged and absolute.

CREATE TABLE destinations (
  destination_id          text        PRIMARY KEY,
  project_id              text        NOT NULL REFERENCES projects(project_id),
  environment             text        NOT NULL,
  vendor                  text        NOT NULL,
  instance_label          text        NOT NULL,
  secret_ref              text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'active',
  mode                    text        NOT NULL DEFAULT 'live',
  max_concurrency         integer     NOT NULL DEFAULT 4,
  max_rps                 integer     NOT NULL DEFAULT 50,
  retry_policy            text        NOT NULL DEFAULT 'standard',
  dead_letter_threshold   integer     NOT NULL DEFAULT 5,
  disabled_reason         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT destinations_destination_id_format
    CHECK (destination_id ~ '^polaris_dst_[A-Za-z0-9._-]+$'),
  CONSTRAINT destinations_environment_allowed
    CHECK (environment IN ('development', 'staging', 'production')),
  CONSTRAINT destinations_status_allowed
    CHECK (status IN ('active', 'paused', 'disabled')),
  CONSTRAINT destinations_mode_allowed
    CHECK (mode IN ('live', 'sandbox', 'test')),
  CONSTRAINT destinations_vendor_format
    CHECK (vendor ~ '^[a-z][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT destinations_instance_label_format
    CHECK (instance_label ~ '^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$'),
  CONSTRAINT destinations_secret_ref_format
    CHECK (secret_ref ~ '^[a-z][a-z0-9_-]*:[^[:space:]]+$'),
  CONSTRAINT destinations_max_concurrency_positive
    CHECK (max_concurrency >= 1 AND max_concurrency <= 1024),
  CONSTRAINT destinations_max_rps_positive
    CHECK (max_rps >= 1 AND max_rps <= 100000),
  CONSTRAINT destinations_dead_letter_threshold_positive
    CHECK (dead_letter_threshold >= 1 AND dead_letter_threshold <= 1000),
  CONSTRAINT destinations_retry_policy_allowed
    CHECK (retry_policy IN ('standard', 'aggressive', 'conservative')),
  CONSTRAINT destinations_unique_label_per_vendor
    UNIQUE (project_id, environment, vendor, instance_label)
);

-- Lookup path for the `polaris destinations list --project --env` command.
CREATE INDEX destinations_project_env_idx ON destinations (project_id, environment);

-- migrate:down

DROP TABLE destinations;
