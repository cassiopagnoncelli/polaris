# RabbitMQ Topology Runbook

Everything Polaris publishes to or consumes from must be declared first.
This runbook covers declaring it, changing it, and diagnosing it.

Binding architecture reference:
[RabbitMQ Streams](../architecture/03-rabbitmq-streams.md).

The declarations live in
[`packages/shared-transport/src/topology.ts`](../../packages/shared-transport/src/topology.ts)
— one source of truth shared by services and by
[`scripts/rabbitmq-provision.mjs`](../../scripts/rabbitmq-provision.mjs).

## The rule that surprises people

RabbitMQ auto-creates **nothing**. Redpanda created a topic on first
publish; RabbitMQ drops the message on the floor. Polaris publishes with
`mandatory: true` so the drop surfaces as a failed publish instead of a
silent hole in the data, but the underlying fact stands: **a
non-provisioned environment does not work.**

`make up` and CI run provisioning. If you brought infra up another way,
run it yourself.

## ACCESS_REFUSED before you get that far

Provisioning authenticates as the user in `POLARIS_RABBITMQ_URL`
(`polaris:polaris` locally). Docker compose creates that user from
`RABBITMQ_DEFAULT_USER`; a bare-metal broker ships only `guest`, so the
first run fails the handshake with `403 (ACCESS-REFUSED)` — a missing user,
not a wrong password.

```bash
pnpm rabbitmq:bootstrap-local
```

Idempotent. Creates the user, vhost, and full permissions named by
`POLARIS_RABBITMQ_URL` via `rabbitmqctl` (which authenticates over the
Erlang cookie, so it needs no broker credentials), and no-ops when the
credentials already work. `make setup` runs it before provisioning.
Local development only — production provisions its broker user
out-of-band with least-privilege permissions.

## Declare or repair the topology

```bash
pnpm rabbitmq:provision
```

Idempotent. Declares every canonical super stream (exchange + partition
streams + index bindings), the diagnostics stream, and every component's
retry tiers, redelivery queue, and DLQ.

Preview without touching the broker:

```bash
pnpm rabbitmq:provision:dry-run
```

## PRECONDITION_FAILED: an object exists with different arguments

This is the failure mode that matters. AMQP rejects an `assert` whose
arguments differ from the existing object — it does not reconcile. That is
deliberate: changing a stream's retention or a super stream's width is a
**migration**, not a restart.

```text
provisioning failed: Channel closed by server: 406 (PRECONDITION_FAILED)
```

Do **not** delete the object to make the error go away. Deleting a stream
deletes its events.

### Changing a stream's retention or size bound

`x-max-age` and `x-max-length-bytes` are set at declaration time. To change
them on a live stream, use a policy instead of a re-declaration — policies
apply to existing objects:

```bash
docker compose exec polaris-rabbitmq rabbitmqctl set_policy \
  polaris-raw-retention '^raw\.events-\d+$' \
  '{"max-age":"30D"}' --apply-to queues
```

Then update `POLARIS_RABBITMQ_STREAM_RETENTION_DAYS` so newly declared
streams match, and record the divergence — a policy that disagrees with
the declaration is a trap for the next operator.

### Changing a super stream's width

**This one breaks ordering if done casually.** The publisher hashes the
partition key modulo the width. Two running instances that disagree about
the width route the same identity to different partitions, and
per-identity ordering is gone for the overlap window.

Procedure:

1. Stop every publisher and consumer for that family.
2. Declare the new partition streams and bindings (raise
   `POLARIS_RABBITMQ_PARTITIONS` or add a
   `POLARIS_RABBITMQ_PARTITION_OVERRIDES` entry, then re-run provisioning).
3. Roll the new width to **every** service that touches the family in one
   deploy — publishers and consumers together.
4. Update `POLARIS_RABBITMQ_ASSIGNED_PARTITIONS` on each replica so the
   new partitions are owned by someone. A partition nobody is assigned is
   a silent backlog.

Events already written to the old partitions stay where they are and are
still consumed; only new writes redistribute. Ordering is preserved going
forward, not retroactively.

## Inspect what exists

```bash
docker compose exec polaris-rabbitmq rabbitmqctl list_queues name type messages consumers
```

```bash
docker compose exec polaris-rabbitmq rabbitmqctl list_exchanges name type
```

```bash
docker compose exec polaris-rabbitmq rabbitmqctl list_bindings source_name routing_key destination_name
```

The management UI (http://localhost:15672, `polaris` / `polaris` locally)
shows the same in a browser.

## Diagnose "nobody is reading this stream"

```bash
docker compose exec polaris-rabbitmq rabbitmqctl list_queues name consumers messages
```

A partition stream with `consumers = 0` is unowned. Causes, in order of
likelihood:

1. `POLARIS_RABBITMQ_ASSIGNED_PARTITIONS` on the running replicas does not
   cover that partition — the usual result of scaling out without
   redistributing the assignment.
2. The consumer crashed and its supervisor has not restarted it.
3. The family's width was raised without step 4 above.

Unlike Kafka, no rebalance will fix this for you. That is the trade of
static assignment: nothing moves without an operator.

## Checkpoints

Consumer position lives in PostgreSQL, not in the broker:

```sql
SELECT group_name, stream, last_offset, updated_at
FROM transport_checkpoints
ORDER BY updated_at;
```

A checkpoint whose `updated_at` is stale while the stream is receiving
traffic means that consumer is stuck — see
[Processor Lag Runbook](runbook-processor-lag.md).

Deleting a checkpoint row rewinds that consumer to the start of retention
and will re-deliver everything. It is a legitimate operator action (for
example, after a poison-message incident), never an automatic one.

## Cross-references

- [RabbitMQ Publish Failures](runbook-rabbitmq-publish-failures.md)
- [Processor Lag](runbook-processor-lag.md)
- [Topic Isolation Cutover](topic-isolation-cutover.md) — declaring a
  dedicated super stream before moving a project onto it.
- [Backup and Retention](backup-and-retention.md)
