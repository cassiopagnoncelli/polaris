-- migrate:up
--
-- Create the `transport_checkpoints` table.
--
-- Per `docs/architecture/03-rabbitmq-streams.md` "Consumer checkpoints":
-- this table is the **authoritative resume point** for every Polaris
-- stream consumer. It replaces Kafka consumer-group offsets, which the
-- broker owned before the RabbitMQ migration.
--
-- Why Polaris owns this rather than the broker:
--
--   - RabbitMQ streams consumed over AMQP 0-9-1 have no server-side
--     offset store. (The native stream protocol has `store_offset` /
--     `query_offset`; Polaris deliberately stays on amqplib for v1 — see
--     `docs/implementation/rabbitmq-redesign-plan.md` "Protocol
--     decision".) A consumer that reconnects must say where to attach,
--     so the offset has to be durable somewhere Polaris controls.
--
--   - Postgres is already the control-plane store and is already a hard
--     dependency of every processor (via `processor_runs`) and every
--     destination consumer (via `delivery_records`). Adding Redis for
--     this would add an availability dependency for no gain.
--
--   - A consumer whose side effects are Postgres writes (identity-resolver)
--     can commit its checkpoint in the SAME transaction as its writes,
--     which is strictly stronger than anything the Kafka setup offered.
--
-- Hard rules baked into the schema:
--
--   - **One row per (group_name, stream).** `group_name` is the Polaris
--     consumer-group identifier (e.g. `sessionizer-v1`), NOT an AMQP
--     concept. `stream` is the concrete partition stream
--     (`raw.events-2`). Together they identify exactly one reader.
--
--   - **`last_offset` is the offset of the last SUCCESSFULLY handled
--     message.** Resume attaches at `last_offset + 1`. It is NOT the
--     last delivered offset — writing it before the handler succeeds
--     would turn at-least-once into at-most-once.
--
--   - **`family` and `partition` are derived from `stream`** and stored
--     so operators can aggregate lag per family without parsing names in
--     SQL. The CHECK keeps them consistent with `stream`.
--
--   - **Rows are never deleted by services.** Removing a checkpoint
--     silently rewinds a consumer to the start of retention. Operators
--     delete rows deliberately (documented in
--     `docs/operations/runbook-processor-lag.md`).
--
-- See:
--   - docs/architecture/03-rabbitmq-streams.md "Consumer checkpoints"
--   - docs/operations/runbook-processor-lag.md
--   - packages/shared-transport/src/checkpoints.ts

CREATE TABLE transport_checkpoints (
  -- Polaris consumer-group identifier. Stable across restarts and
  -- deploys of the same component+version; changing it rewinds the
  -- consumer, so it is treated as part of the component's contract.
  group_name    text        NOT NULL,

  -- Concrete partition stream, e.g. `raw.events-2`.
  stream        text        NOT NULL,

  -- Logical stream family, e.g. `raw.events`. Derived from `stream`.
  family        text        NOT NULL,

  -- Partition index within the family's super stream. Derived from
  -- `stream`.
  partition     integer     NOT NULL,

  -- Offset of the last successfully handled message. RabbitMQ stream
  -- offsets are unsigned 64-bit; bigint covers the range Polaris can
  -- physically reach (2^63 messages per partition).
  last_offset   bigint      NOT NULL,

  -- Wall-clock time the checkpoint was last advanced. Drives the
  -- "consumer is stalled" operational query.
  updated_at    timestamptz NOT NULL DEFAULT now(),

  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (group_name, stream),

  CONSTRAINT transport_checkpoints_group_name_length
    CHECK (length(group_name) >= 1 AND length(group_name) <= 128),
  CONSTRAINT transport_checkpoints_stream_length
    CHECK (length(stream) >= 1 AND length(stream) <= 255),
  CONSTRAINT transport_checkpoints_family_length
    CHECK (length(family) >= 1 AND length(family) <= 255),
  CONSTRAINT transport_checkpoints_partition_non_negative
    CHECK (partition >= 0),
  CONSTRAINT transport_checkpoints_last_offset_non_negative
    CHECK (last_offset >= 0),
  -- `stream` must be exactly `<family>-<partition>`. Prevents a
  -- hand-written UPDATE from pointing a checkpoint at the wrong
  -- partition's stream.
  CONSTRAINT transport_checkpoints_stream_shape
    CHECK (stream = family || '-' || partition::text)
);

-- "How far behind is each family?" — the operational lag query, and the
-- lookup the CLI uses to render `polaris streams checkpoints`.
CREATE INDEX transport_checkpoints_family_idx
  ON transport_checkpoints (family, partition);

-- "Which consumers have stopped advancing?" — stalled-consumer sweep.
CREATE INDEX transport_checkpoints_updated_at_idx
  ON transport_checkpoints (updated_at);

-- migrate:down

DROP TABLE IF EXISTS transport_checkpoints;
