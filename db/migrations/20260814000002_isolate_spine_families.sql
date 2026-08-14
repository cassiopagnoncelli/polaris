-- migrate:up
--
-- Widen `topic_isolations.topic_family` to cover the three families the
-- pipeline redesign adds: `identified.events`, `resolved.events`, and
-- `profile.events`.
--
-- The CHECK mirrors `CANONICAL_STREAM_FAMILIES` in
-- `packages/shared-transport/src/streams.ts`, and a schema-invariant test
-- (`packages/shared-control-plane-db/test/topic-isolations-migration.test.ts`)
-- asserts the two stay in step — which is how this migration got written:
-- adding the families to the constant failed that test rather than
-- silently leaving a project unable to isolate the busiest stream in the
-- platform.
--
-- Why the spine needs this at all: `resolved.events` inherits every
-- isolation trigger `raw.events` has (volume share, lag isolation,
-- retention divergence, operational quarantine) because it carries the
-- same event volume. A project that graduates `raw.events` to a dedicated
-- stream and cannot graduate its spine has only moved the hot partition
-- one hop downstream.
--
-- Dropping and recreating is the only way to alter a CHECK in PostgreSQL.
-- Existing rows are unaffected: the new list is a strict superset, so
-- every row that satisfied the old constraint satisfies this one.

ALTER TABLE topic_isolations
  DROP CONSTRAINT topic_isolations_topic_family_allowed;

ALTER TABLE topic_isolations
  ADD CONSTRAINT topic_isolations_topic_family_allowed
    CHECK (topic_family IN (
      'raw.events',
      'identified.events',
      'resolved.events',
      'profile.events',
      'identity.events',
      'enriched.events',
      'session.events',
      'attribution.events',
      'analytics.events'
    ));

-- migrate:down

-- Narrowing back would orphan any isolation row for a spine family, so
-- refuse rather than silently drop the constraint's protection: an
-- operator rolling this back must first de-isolate those projects.
DELETE FROM topic_isolations
  WHERE topic_family IN ('identified.events', 'resolved.events', 'profile.events');

ALTER TABLE topic_isolations
  DROP CONSTRAINT topic_isolations_topic_family_allowed;

ALTER TABLE topic_isolations
  ADD CONSTRAINT topic_isolations_topic_family_allowed
    CHECK (topic_family IN (
      'raw.events',
      'identity.events',
      'enriched.events',
      'session.events',
      'attribution.events',
      'analytics.events'
    ));
