-- Drop `analytics.events` and `enriched.events` from the allowed topic
-- families.
--
-- 126EPNIQ retires the fan-out: `analytics-projector` and `geoip-enricher`
-- are gone, and with them the two families they produced. The spine's
-- `resolved.events` replaces `analytics.events`, and geo now rides the
-- envelope's `enrichment` block on that same family rather than travelling
-- as its own event.
--
-- This CHECK mirrors `CANONICAL_STREAM_FAMILIES` in
-- `packages/shared-transport/src/streams.ts`. The two are a list written
-- twice, so they drift silently unless changed together -- the constant
-- decides what is provisioned and subscribed, this decides what may be
-- isolated for a project, and a family in one but not the other is
-- isolable-but-unprovisioned or the reverse.
--
-- ## Rows first, constraint second
--
-- An isolation row naming a retired family points at a super-stream that
-- no longer exists, so the DELETE is not cleanup around the constraint --
-- it is the actual retirement. A project isolated onto
-- `analytics.events.<id>` would otherwise keep a dedicated topic nothing
-- declares and nothing writes.

-- migrate:up

DELETE FROM topic_isolations
  WHERE topic_family IN ('analytics.events', 'enriched.events');

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
      'session.events',
      'attribution.events'
    ));

-- migrate:down

-- Widening only. The rows deleted above are NOT restored: their families
-- were decommissioned in the broker, so re-inserting them would recreate
-- isolation records pointing at streams that no longer exist. A down
-- migration that puts back a lie is worse than one that leaves the table
-- narrower than it was.

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
