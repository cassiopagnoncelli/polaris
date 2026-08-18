# RabbitMQ Streams

## Role

RabbitMQ is the canonical event transport backbone for Polaris.

RabbitMQ owns:

- canonical event transport
- immutable append-only event logs (streams)
- replay source
- stream retention
- retry scheduling and dead-lettering
- future tiered storage or archive integration

RabbitMQ must not be used as RPC.

Polaris owns one thing the broker does not: **consumer position**. See
"Consumer checkpoints" below.

## Why RabbitMQ, and what that costs

Polaris ran on Redpanda (Kafka API) through v1. The migration to RabbitMQ
kept every semantic the platform actually depends on, but two of them are
now Polaris's job rather than the broker's:

| Property | Kafka era | RabbitMQ era |
|---|---|---|
| Append-only re-readable log | topics | **streams** (non-destructive read) |
| Ordering per identity | partition key → partitioner | partition key → client-side hash → super-stream routing key |
| Consumer position | broker-held group offsets | **`transport_checkpoints` in PostgreSQL** |
| Partition ownership | coordinator rebalance | **static assignment from config** |
| Replay by time | admin time→offset lookup, then offset reads | attach at timestamp directly |
| Retry backoff | consumer sleeps | broker holds the message in a TTL'd queue |
| ClickHouse ingestion | ClickHouse's Kafka Engine pulled | `clickhouse-sink` pushes |

The two "now Polaris's job" rows are the real cost. Everything else got
simpler or stayed the same.

## Nothing is auto-created

This is the single most important operational difference from Kafka.

Redpanda created a topic on first publish. RabbitMQ creates nothing:

- publishing to an exchange that does not exist, or that has no matching
  binding, **silently drops the message** (Polaris publishes with
  `mandatory` and treats the resulting return as a failure — see below);
- consuming from a stream that does not exist **kills the channel**.

Every stream, exchange, and queue is therefore declared explicitly by
`packages/shared-transport/src/topology.ts`, which
`scripts/rabbitmq-provision.mjs` runs. `make up` and CI run it. A fresh
environment without it does not work, and that is by design — a silent
partial topology is worse than a loud missing one.

Because a dropped publish would otherwise be invisible, the producer sets
`mandatory: true` and fails the publish when the broker returns the
message as unroutable. `rabbitmq_channel_messages_unroutable_dropped_total`
is on the RabbitMQ dashboard for the same reason.

## Default canonical streams

Polaris uses shared canonical stream families by default:

```text
raw.events
identified.events
resolved.events
profile.events
identity.events
session.events
attribution.events
```

`rejected.events` is declared alongside these but is deliberately NOT
canonical: it supports no per-project isolation, so consumers subscribe to
it bare. See `CANONICAL_STREAM_FAMILIES` in
`packages/shared-transport/src/streams.ts`, which this list mirrors — and
which `topic_isolations`' CHECK constraint mirrors in turn.

All projects flow through these shared families. Separation is provided by
envelope fields, partition keys, schemas, processor configuration, and
consumer filtering.

Shared streams are a deliberate trade-off that fits Polaris's internal
posture (cross-project visibility is allowed by design). They keep ops
simple, but they couple lag, retention, and consumer health across
projects. The triggers below decide when a project graduates to a
dedicated stream.

> `session.events` became canonical with this migration. The sessionizer
> always emitted it, but under Redpanda it was an auto-created topic that
> no constant, migration, or provisioning step knew about. RabbitMQ forced
> the question.

## Super streams

Every family is a RabbitMQ **super stream**: a direct exchange named after
the family, fronting N partition streams bound with the partition index as
the routing key.

```text
exchange  raw.events                    (direct, durable)
  binding "0" -> stream raw.events-0
  binding "1" -> stream raw.events-1
  binding "2" -> stream raw.events-2
```

This layout is byte-for-byte what `rabbitmq-streams add_super_stream`
produces, so the management CLI, the native stream protocol client, and
`@polaris/shared-transport` all agree on names.

Width is config (`POLARIS_RABBITMQ_PARTITIONS`, with per-family overrides
in `POLARIS_RABBITMQ_PARTITION_OVERRIDES`). Defaults: `raw.events` = 6,
everything else = 3. **Changing a width is a migration, not a restart** —
the publisher hashes the partition key modulo the width, so two instances
disagreeing about it breaks per-identity ordering. See
`docs/operations/runbook-rabbitmq-topology.md`.

## Partition key and routing

The default partition key is unchanged from the Kafka era:

```text
project_id + ":" + environment + ":" + best_available_identity
```

Identity fallback order:

```text
customer_id
anonymous_id
session_id
event_id
```

What changed is who hashes it. Kafka's client library mapped key →
partition internally. RabbitMQ super streams put that decision in the
publisher's hands: the routing key *is* the partition index, and
`partitionForKey` (32-bit FNV-1a, in
`packages/shared-transport/src/partition-key.ts`) owns the mapping. Its
output is a wire contract — changing the hash mid-deploy breaks ordering
exactly as changing a Kafka partitioner would.

## Stream families and isolation

Canonical names refer to a family, not a fixed concrete super stream.
Producers and consumers resolve the family through the source registry.

```text
raw.events                 shared default
raw.events.<project_id>    dedicated, created on isolation
```

The resolver returns:

- `raw.events` for projects not currently isolated
- `raw.events.<project_id>` for projects with an active isolation record

The `shared-transport` package owns this resolution and exposes a stable
interface to processor and consumer code, so isolation is operational, not
structural. A dedicated family inherits its parent's partition width
unless it carries its own override, so an isolated project keeps the
ordering guarantees of the stream it graduated from.

### Isolation triggers

A project moves to a dedicated stream when any of these is true and
persists for at least one operational review cycle:

- **Volume share**: one project drives more than 25% of a shared family's
  sustained throughput, or any single partition is repeatedly hot because
  of that project's identity key distribution.
- **Retention divergence**: the project requires a materially different
  retention than the shared default (for example, a 7-day compliance cap
  or a 365-day archive requirement). "Materially different" means a delta
  that would change RabbitMQ disk sizing or break the shared TTL contract.
- **Lag isolation**: the project's primary consumer cannot keep up and is
  dragging end-to-end lag SLOs for unrelated projects.
- **Schema risk**: the project's experimental or high-cardinality event
  traffic would meaningfully degrade validation latency or skew metrics
  for unrelated projects.
- **Operational quarantine**: an incident requires temporarily isolating a
  project's traffic so other projects continue flowing.

A project moves back to shared streams when its trigger condition has been
resolved for a documented period. Moves are CLI-driven and audited; the
new super stream must be declared before the cutover (see
`docs/operations/topic-isolation-cutover.md`).

### Dedicated stream escape hatch

Beyond the formal triggers, dedicated streams may be introduced when an
explicit decision is recorded for one of these reasons:

- consumer blast-radius reduction during a known-risky migration
- replay isolation when a replay would otherwise pollute the shared stream
- explicit security-perimeter requirements that override the default
  internal posture (rare; requires a written exception note)

Dedicated streams remain the exception. The default is shared.

## Consumer checkpoints

**RabbitMQ streams consumed over AMQP 0-9-1 have no server-side offset
store.** A reconnecting consumer must say where to attach. Polaris keeps
that position in PostgreSQL (`transport_checkpoints`, one row per
`(group_name, stream)`).

Rules:

- `last_offset` is the offset of the last **successfully handled**
  message. Resume attaches at `last_offset + 1`. Writing it on delivery
  instead of on success would turn at-least-once into at-most-once.
- Checkpoints only move forward. A straggler consumer overlapping a newer
  one (slow pod shutdown) cannot rewind it.
- Flush cadence is `POLARIS_RABBITMQ_CHECKPOINT_EVERY` messages or
  `POLARIS_RABBITMQ_CHECKPOINT_INTERVAL_MS`, whichever trips first, plus a
  forced flush on clean shutdown. Larger values mean fewer Postgres writes
  and more redelivery after a crash. Lag in that direction is always
  safe: it only ever causes re-delivery.

- **A handler that defers its side effect must defer its checkpoint too.**
  The consumer advances the position as soon as the handler resolves,
  which is correct only when the effect completed inside the call. The
  ClickHouse sink batches, so its handler returns for rows still sitting
  in memory; it wraps its store in `DeferredCheckpointStore` and commits
  only after ClickHouse acknowledges the INSERT. Any future consumer that
  buffers must do the same, or its checkpoint will claim work the process
  can still lose.
- Deleting a checkpoint row rewinds that consumer to the start of
  retention. Operators do this deliberately, never services.

A consumer whose side effects are Postgres writes can commit its
checkpoint in the same transaction as those writes — strictly stronger
than anything the Kafka setup offered.

## Static partition assignment

Kafka consumer groups rebalanced. RabbitMQ has no equivalent for streams,
so each instance is configured with the partitions it owns
(`POLARIS_RABBITMQ_ASSIGNED_PARTITIONS`; empty means "all", which is
correct for single-instance deployments).

Scaling a processor out means giving each replica a disjoint slice and
restarting. The upside: no rebalance storms, no stop-the-world pauses, and
no ambiguity about who owns what during an incident. The downside is
honest — it is a config change, not an autoscale. See
`docs/operations/runbook-processor-lag.md`.

Within a partition, handlers run strictly in order. Prefetch
(`POLARIS_RABBITMQ_PREFETCH`) controls how far the broker runs ahead, not
how many handlers run at once — per-identity ordering survives.

## Failure handling

A handler that throws means "not processed". The consumer does not ack,
cancels its stream consumer, and re-attaches at `checkpoint + 1` after a
backoff, so the message is redelivered. This is the faithful mapping of
KafkaJS's "throw and the batch is retried"; `basic.nack` with requeue is
not meaningful on a stream, where nothing is ever removed.

Components that want retry/DLQ routing instead of redelivery catch the
error themselves and call the helpers in `@polaris/shared-transport/dlq`.

Two properties of the rewind are easy to get wrong and are worth stating
explicitly, because both were bugs before they were features:

**In-flight deliveries are discarded.** Prefetch means the broker pushes
up to `POLARIS_RABBITMQ_PREFETCH` messages ahead of the handler, so a
rewind always leaves some already queued. Those messages sit at *higher*
offsets than the one that failed; processing them would advance the
checkpoint past the failure and silently skip the very event the rewind
exists to retry. Each attach therefore carries an epoch, and deliveries
from a superseded epoch are dropped.

**A message that always fails is dead-lettered, not retried forever.**
After `maxDeliveryAttempts` consecutive failures at the same offset
(default 5), the consumer publishes the message to `<component>.dlq`,
advances past it, and emits `consumer.poisoned`. Without this, one bad
payload pins its partition indefinitely and every healthy event behind it
waits with it — with only the lag alert to notice.

The counter is per-offset, so an intermittent error never trips it;
only a message that cannot make progress does. If a component is wired
without a DLQ target the consumer keeps rewinding rather than dropping
the event, but escalates the log and still emits `consumer.poisoned` —
a visible stall beats silent loss.

## Retry and DLQ queues

Processors and consumers own their retry and DLQ queues. These are
**quorum queues**, not streams, and the broker owns the delay:

```text
<component>.retry.5000      ttl 5s    ─┐
<component>.retry.30000     ttl 30s    ├─ expire ─> <component>.retry.dlx
<component>.retry.120000    ttl 2m     │                  │ rk=redeliver
<component>.retry.600000    ttl 10m    │                  v
<component>.retry.1800000   ttl 30m   ─┘        <component>.redeliver
                                                           │ delivery limit
                                                           v rk=dlq
<component>.dlq             terminal   <──────── <component>.retry.dlx
```

Each backoff tier is its own queue with a queue-level `x-message-ttl`. The
obvious alternative — one retry queue with per-message `expiration` — is
wrong for RabbitMQ: TTL expiry is evaluated at the *head* of the queue, so
one message with a 30-minute backoff parked at the head holds back every
5-second retry behind it.

Components consume their `<component>.redeliver` queue alongside their
streams, which is what closes the retry loop. Under Kafka the consumer
slept the backoff itself, burning a consumer slot and making the delay
invisible to operators.

The redelivery queue dead-letters into the DLQ, so a poison message that
keeps failing lands somewhere an operator can see instead of being dropped
when the quorum queue's delivery limit is reached.

Retries and DLQs must include enough metadata to diagnose source event,
processor/consumer version, error class, attempts, and timestamps. The
`polaris-*` headers carry it; `polaris-source-topic` now holds a concrete
partition stream name (`raw.events-2`).

## Retention

Initial retention policy:

```text
raw.events        90 days   (x-max-age, plus x-max-length-bytes per partition)
derived streams   family-specific, usually shorter
diagnostics       7 days
retry / dlq       until resolved according to operational policy
```

Streams are bounded by **both** age and size. Age alone lets a traffic
spike inside the retention window fill the disk, and a full disk blocks
publishes cluster-wide.

Retention is applied at declaration time (`x-max-age`), so changing
`POLARIS_RABBITMQ_STREAM_RETENTION_DAYS` affects only streams that do not
exist yet. Changing it for a live stream is a topology migration.

Long-term historical analytics live in ClickHouse. Long-term raw replay
should eventually come from an object-storage archive, not indefinite
stream retention.

## SDK diagnostics stream (optional, not yet declared)

SDKs do not emit diagnostic events to Polaris by default. Operators may
opt into a diagnostic stream per project, per environment:

```text
polaris.diagnostics.events
```

Producers (SDK installations with diagnostic emission enabled) write
SDK-side operational signals here: queue pressure, storage fallback, retry
failures, dropped events, validation failures, flush outcomes. The
diagnostic stream is not part of the canonical event path and never feeds
analytics or destinations.

Rules:

- Opt-in per SDK installation. The SDK default remains "no automatic
  diagnostic events."
- Diagnostic events use the same canonical envelope but always set `event`
  to a `polaris.diagnostics.*` namespace.
- Diagnostic events must not contain raw user PII or canonical-event
  payloads.
- The stream has its own short retention (7 days) and is not consumed by
  processors or destinations.
- A small `polaris diagnostics inspect` CLI command lets operators tail
  the stream for a project.

**Not provisioned yet.** Nothing produces to this stream: no SDK emits
diagnostics and `polaris diagnostics inspect` does not exist. Declaring
it anyway would reserve disk and put a permanently-empty stream on every
dashboard — and an always-idle stream teaches operators to ignore idle
streams, which is the opposite of what the queue-depth panels are for.
`diagnosticsSuperStream()` in `packages/shared-transport/src/topology.ts`
builds the spec; add it to the provisioning call in the same change that
ships a producer.

## Per-project observability

Per-project metrics are required from day one, not added when isolation is
needed. Isolation triggers are observable only if the metrics exist.

Required labels:

```text
project_id
environment
topic_family
concrete_topic
partition
```

> The label keys keep their Kafka-era names on purpose. They are what
> every dashboard and alert rule already groups by; renaming them would
> break those queries for zero semantic gain. `concrete_topic` carries a
> partition stream name now.

Required dashboards before any project graduates to a dedicated stream:

- per-project share of shared-stream throughput
- per-project consumer lag
- per-partition skew on shared streams, grouped by project_id
- per-project schema validation rate and error rate

## Connections and recovery

One supervised AMQP connection per service process, shared by that
process's producer and consumer.

The connection is supervised by `shared-transport`, **not** by amqplib's
built-in `recovery` option. amqplib can transparently re-open a connection
and replay channel setup including `basic.consume` — correct for classic
queues, wrong for streams: the replayed consume carries the original
`x-stream-offset` argument, so it would re-attach at the offset the
process booted with and reprocess everything since. Polaris re-attaches at
the checkpoint, which only the consumer knows.

## Event semantics

Events are immutable facts.

Good:

```text
payment.approved
checkout.started
subscription.renewed
```

Bad:

```text
process_payment_now
send_to_meta
update_customer_profile
```

Commands, imperative workflows, and vendor-specific actions do not belong
in canonical event streams.
