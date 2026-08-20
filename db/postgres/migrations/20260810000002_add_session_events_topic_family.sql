-- migrate:up
--
-- Widen `topic_isolations.topic_family` to include `session.events`.
--
-- Background: the sessionizer has always emitted `session.events`, but
-- the family was never in `CANONICAL_TOPIC_FAMILIES`. Under Redpanda that
-- worked by accident — the broker auto-created the topic on first
-- publish, so nothing forced the family to be declared anywhere.
--
-- RabbitMQ creates nothing implicitly: an undeclared exchange drops
-- publishes on the floor. `session.events` is therefore now a first-class
-- canonical family in `packages/shared-transport/src/streams.ts`, which
-- means it must also be isolatable like every other family — otherwise a
-- high-volume project could never graduate its session traffic off the
-- shared stream.
--
-- The CHECK is recreated rather than altered because PostgreSQL has no
-- in-place CHECK modification; the table is small (one row per isolation
-- window, ever) so the rewrite is trivial.
--
-- See:
--   - docs/architecture/03-rabbitmq-streams.md "Default Canonical Streams"
--   - packages/shared-transport/src/streams.ts CANONICAL_STREAM_FAMILIES

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

-- migrate:down

-- Rows referencing the newly-allowed family must go before the narrower
-- CHECK can be restored; they cannot be represented in the old schema.
DELETE FROM topic_isolations WHERE topic_family = 'session.events';

ALTER TABLE topic_isolations
  DROP CONSTRAINT topic_isolations_topic_family_allowed;

ALTER TABLE topic_isolations
  ADD CONSTRAINT topic_isolations_topic_family_allowed
    CHECK (topic_family IN (
      'raw.events',
      'identity.events',
      'enriched.events',
      'attribution.events',
      'analytics.events'
    ));
