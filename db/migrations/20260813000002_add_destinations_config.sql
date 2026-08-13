-- migrate:up
--
-- Per-instance, consumer-interpreted configuration values.
--
-- Two destination instances of one vendor may serve the same
-- (project, environment) — two Meta pixels, say; that is exactly what
-- `destinations_unique_label_per_vendor` exists to permit, and
-- `resolveFanoutTargets` delivers to all of them. So values that distinguish
-- one instance from its siblings (pixel_id, measurement_id, a webhook URL)
-- cannot key on (project, environment) alone: they belong to the instance row
-- (docs/implementation/project-config-plan.md §3.3).
--
-- Boundary, so it cannot drift:
--   - typed COLUMNS on this table are the knobs the SHARED destination
--     runtime interprets (status, mode, max_rps, max_concurrency,
--     retry_policy, dead_letter_threshold, replay_opt_in);
--   - `config` carries values only the CONSUMER'S OWN CODE interprets;
--   - `project_config` carries values shared across the whole project;
--   - credentials stay in `secret_ref`.
--
-- And as everywhere on this table: no mappings, no routing, no transforms,
-- no field maps. `config` holds parameters, never semantics.

ALTER TABLE destinations
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}';

-- migrate:down

ALTER TABLE destinations
  DROP COLUMN config;
