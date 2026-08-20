-- migrate:up
--
-- M0DROHV3: stamp the operational build version on `delivery_records`.
--
-- Background:
--
--   `consumer_version` is the SEMANTIC consumer version (v1 / v2 / ...);
--   it changes only when the consumer's deliverer or descriptor identity
--   does. Operationally, the team frequently rolls out the SAME semantic
--   version with a new image tag — a hot-fix, a logger tweak, an
--   observability patch. Bisecting a regression to one of those rollouts
--   today requires joining `delivery_records` against the rollout
--   timeline; this column makes the join unnecessary by stamping the
--   build version directly on every row.
--
-- Behavior:
--
--   - `consumer_build_version` is a nullable text column. Existing rows
--     stay NULL after the migration; new rows carry whatever
--     `getBuildMetadata()` resolves at the consumer's app startup
--     (first non-null of releaseLabel / gitSha / serviceVersion).
--
--   - Capped at 128 chars. That's plenty for a release label like
--     `2026-q2-r1`, a 40-char git SHA, or a SemVer + pre-release tail.

ALTER TABLE delivery_records
  ADD COLUMN consumer_build_version text;

ALTER TABLE delivery_records
  ADD CONSTRAINT delivery_records_consumer_build_version_length
    CHECK (
      consumer_build_version IS NULL
      OR length(consumer_build_version) <= 128
    );

-- migrate:down

ALTER TABLE delivery_records
  DROP CONSTRAINT IF EXISTS delivery_records_consumer_build_version_length;

ALTER TABLE delivery_records
  DROP COLUMN IF EXISTS consumer_build_version;
