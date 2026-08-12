# Topic Isolation Cutover Runbook

> **Not available in this build.** `polaris topics isolate` refuses with
> `not_implemented`. No producer or consumer reads the isolation row —
> every one of them resolves stream families through
> `sharedOnlyIsolationLookup`, and no service constructs a
> `StreamIsolationCache` — so a cutover started from this page would move
> no traffic while reporting success. The sequence below is retained as the
> design to implement, not as a runbook to follow.

Operators use this runbook when a project graduates from a shared
canonical RabbitMQ topic to a dedicated topic
(`<family>.<project_id>`), or rolls the move back once the trigger has
resolved.

Binding architecture references:

- [RabbitMQ Streams / Topic Isolation Triggers](../architecture/03-rabbitmq-streams.md)
- [RabbitMQ Streams / Topic Families](../architecture/03-rabbitmq-streams.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)

The CLI surface this runbook depends on lives at
[`apps/polaris-cli/src/commands/topics/`](../../apps/polaris-cli/src/commands/topics/).
The matching resolver and cache live in
[`packages/shared-transport/src/topic-family.ts`](../../packages/shared-transport/src/topic-family.ts)
and
[`packages/shared-transport/src/topic-isolation-cache.ts`](../../packages/shared-transport/src/topic-isolation-cache.ts).
The migration that owns the persistent state is
[`db/migrations/20260514000003_create_topic_isolations.sql`](../../db/migrations/20260514000003_create_topic_isolations.sql).

## What "topic isolation" means

Polaris references logical **topic families** in code (`raw.events`,
`identity.events`, `enriched.events`, `attribution.events`,
`analytics.events`). The resolver in `@polaris/shared-transport` returns:

- the shared family topic (e.g. `raw.events`) for projects on the
  shared default;
- the dedicated topic (e.g. `raw.events.storefront`) for projects with
  an active `topic_isolations` row.

The control plane mutates state in PostgreSQL only; the runtime
re-resolves through a TTL-bounded in-memory cache (default 60s window)
so a `polaris topics isolate` lands across all services within one
cache TTL without restart.

## When to isolate

Per `docs/architecture/03-rabbitmq-streams.md`, a project moves to a
dedicated topic when any of the documented triggers fires AND the
trigger has persisted for at least one operational review cycle:

| Trigger | Signal | Dashboard |
|---|---|---|
| **Volume share** | One project drives more than 25% of a shared topic's sustained throughput. | `Polaris — Per-Project Shared-Topic Throughput` |
| **Volume share (skew)** | A single partition is repeatedly hot because of one project's identity-key distribution. | `Polaris — Per-Partition Skew (Per-Project)` |
| **Retention divergence** | The project requires a materially different retention than the shared default (would change RabbitMQ disk sizing or break the shared TTL contract). | Operator-driven from compliance / archive requirements. |
| **Lag isolation** | The project's primary consumer cannot keep up with the shared stream and is dragging end-to-end lag SLOs for unrelated projects. | `Polaris — Per-Project Consumer Lag` |
| **Schema risk** | The project's experimental or high-cardinality event traffic would meaningfully degrade validation latency or skew metrics for unrelated projects. | `Polaris — Per-Project Schema Validation` |
| **Operational quarantine** | An incident requires temporarily isolating a project's traffic so other projects continue flowing. | Incident commander's call. |

All four required dashboards live under
[`infra/grafana/dashboards/`](../../infra/grafana/dashboards/).

## CLI surface

| Command | Mutating? | Audited? | Description |
|---|---|---|---|
| `polaris topics list [--project <id>] [--env <env>]` | no | n/a | List currently-active isolations, optionally filtered. |
| `polaris topics isolate --project <id> --env <env> --family <name> --reason "..."` | **yes** | **yes (`topics.isolate`)** | Activate isolation. Inserts one `topic_isolations` row + one `audit_records` row in a single transaction. Returns the dedicated topic name and the cutover instructions. |
| `polaris topics deisolate --project <id> --env <env> --family <name> [--reason "..."]` | **yes** | **yes (`topics.deisolate`)** | Deactivate isolation. Stamps `deactivated_at` on the active row + writes an `audit_records` row. Preserves history (no DELETE). |

Mutating commands honor the P6-007 production gate: against
`POLARIS_ENV=production` without an authenticated actor, the
dispatcher rejects them and requires an operator token. Set
`POLARIS_OPERATOR_TOKEN=<token>` issued via
`polaris operators create` before running the mutation.

## Standard cutover procedure

Producer-first / consumer-second. The resolver's cache TTL is the
synchronization signal — once the new row is written, every service
that wired the cache picks up the change within one TTL window.

### 1. Verify the trigger

Open the relevant dashboard from the table above. The trigger should
have persisted for **one operational review cycle** (the default is
two consecutive review meetings; per-team policy may extend that
window). Capture screenshots for the audit record.

### 2. Provision the dedicated super stream

The CLI does NOT create the RabbitMQ objects itself (that is an
infrastructure concern), and **RabbitMQ auto-creates nothing** — a
publish to an undeclared exchange is returned as unroutable and the
event never lands.

Declare the dedicated super stream (exchange + partition streams +
index bindings) BEFORE activating the isolation. Its width must match
the parent family's, or the isolated project's per-identity ordering
changes as it moves. Provision through the same Terraform / pulumi
module that owns the shared family:

```hcl
resource "rabbitmq_topic" "raw_events_storefront" {
  name               = "raw.events.storefront"
  partition_count    = var.raw_events_partition_count
  replication_factor = var.raw_events_replication_factor
  retention_ms       = var.raw_events_retention_ms
  config             = var.raw_events_extra_config
}
```

Partition count and retention should match or exceed the shared
topic's settings unless the trigger is **retention divergence** (in
which case the new retention is the whole point of the isolation).

### 3. Activate the isolation

```bash
POLARIS_OPERATOR_TOKEN=<token> polaris topics isolate \
  --project storefront \
  --env production \
  --family raw.events \
  --reason "volume share at 32% for two review cycles (P11-Q2-001)"
```

The command:

- writes a `topic_isolations` row with `activated_at = now()`,
  `deactivated_at = null`, and the operator-supplied reason;
- writes an `audit_records` row (`action='topics.isolate'`,
  `target_type='topic_isolation'`) in the SAME transaction;
- prints the dedicated topic name + the in-line cutover instructions;
- returns the platform-issued `polaris_tiso_<uuidv7>` id.

A duplicate-active request (one isolation already active for the
triple) returns a typed usage error.

### 4. Wait for producers to migrate

Within one resolver-cache TTL window (default 60s), every Polaris
service that imports
`@polaris/shared-transport`'s `StreamIsolationCache` starts producing to
the dedicated topic. Verify on the throughput dashboard:

- `polaris_ingest_batch_accepted_total{topic_family="raw.events", concrete_topic="raw.events.storefront", project_id="storefront"}` should start climbing;
- `polaris_ingest_batch_accepted_total{topic_family="raw.events", concrete_topic="raw.events", project_id="storefront"}` should flatten to zero new acceptances after the TTL window (existing in-flight batches finish on the old stream).

### 5. Drain the shared topic for this project

Consumers continue reading from the shared topic until the partitions
matching the isolated project drain. Verify on the consumer-lag
dashboard:

- The shared-topic lag for this project drops monotonically;
- New traffic appears on the dedicated topic.

### 6. Restart consumers (cold migration) OR rely on dynamic subscribe

Consumers built on `@polaris/shared-transport`'s
`consumerFamiliesFor(family, isolatedProjectIds)` helper already read
the union (`family` + dedicated families). For consumers that read
`family` alone, a rolling restart picks up the new one.

Verify that every partition of the dedicated super stream has a reader
— RabbitMQ will not rebalance one to you:

```bash
docker compose exec polaris-rabbitmq \
  rabbitmqctl list_queues name consumers | grep '<dedicated_family>-'
```

A partition with `consumers = 0` is an unowned backlog; fix the
replicas' `POLARIS_RABBITMQ_ASSIGNED_PARTITIONS`.

### 7. Verify dashboards

Once drain completes and consumers have re-subscribed:

- `Polaris — Per-Project Shared-Topic Throughput` shows the project at
  ~0% share of the shared family;
- `Polaris — Per-Project Consumer Lag` shows the project lag against
  the dedicated topic, separated from the shared-topic lag of other
  projects;
- `Polaris — Per-Partition Skew (Per-Project)` shows no per-partition
  hot spots on the shared topic for this project;
- `Polaris — Per-Project Schema Validation` continues to show this
  project's accepted / rejected rate independently.

The cutover is complete.

## Rollback procedure

Run when the trigger has resolved for a documented period (default:
two operational review cycles) AND the dedicated topic has drained
(no un-consumed messages, no pending replay jobs that would
republish onto it).

### 1. Verify drain

Compare each partition's checkpoint against the stream's message count:

```sql
-- PostgreSQL
SELECT stream, last_offset, updated_at
FROM transport_checkpoints
WHERE family = '<dedicated_family>'
ORDER BY stream;
```

```bash
docker compose exec polaris-rabbitmq \
  rabbitmqctl list_queues name messages | grep '<dedicated_family>-'
```

A checkpoint that has stopped advancing while messages remain means the
stream has NOT drained. Use
`polaris dlq list --vendor <vendor>` to confirm no DLQ entries
reference the dedicated topic.

### 2. Deactivate the isolation

```bash
POLARIS_OPERATOR_TOKEN=<token> polaris topics deisolate \
  --project storefront \
  --env production \
  --family raw.events \
  --reason "trigger resolved for two review cycles; dedicated topic drained on 2026-08-01"
```

The command:

- stamps `deactivated_at = now()` on the active row (the row is NOT
  deleted; it survives as history);
- writes an `audit_records` row (`action='topics.deisolate'`) in the
  SAME transaction;
- prints the affected row id and the reason.

Re-running on an already-deactivated triple returns a typed usage
error with the deactivation timestamp.

### 3. Wait for producers to cut back to the shared topic

Within one resolver-cache TTL window, producers start writing back to
the shared family. The dedicated topic stops receiving new traffic.

### 4. Drain the dedicated topic (one more time)

Consumers continue reading from the dedicated topic until empty. Once
empty, the topic can be torn down through Terraform / pulumi (the
same module that provisioned it).

### 5. Verify dashboards

The per-project share on the shared family climbs back to the project's
expected share, and the dedicated-topic metrics flatten to zero.

## Troubleshooting

### "Cache stale" symptoms

If, within five TTL windows of `polaris topics isolate`, services
still write to the shared topic for the isolated project:

1. Confirm the row exists: `polaris topics list --project <id> --env <env>`.
2. Confirm the service that is writing to the shared topic wired the
   cache: check its `createPolarisProducer({ ... isolation: ... })`
   call site. A producer that ships with `sharedOnlyIsolationLookup`
   will NEVER pick up isolation; that is intentional and used for
   bootstrap / test scenarios.
3. Restart the offending service. The TTL window is bounded, not
   guaranteed — a process that holds a long-lived in-flight batch can
   continue producing to the old topic for the duration of that batch.

### Concurrent `polaris topics isolate` runs

Both calls hit the partial unique index on `topic_isolations`. One
INSERT lands; the second returns the typed
`polaris: topic_isolations: project "X" is already isolated for
family "Y" in environment "Z"` usage error. No duplicate active state
is reachable; this is a schema-level guarantee.

### Operator runs `deisolate` before the dedicated topic is drained

The resolver returns the shared topic for new produces; the dedicated
topic still holds un-consumed messages. Two options:

1. **Re-isolate**: run `polaris topics isolate` again. The new row has
   a new id; the dedicated topic resumes receiving new produces. The
   old isolation row stays as history.
2. **Hand-replay**: use `polaris replay create --target consumers` to
   re-publish the dedicated topic's contents onto the shared topic.
   Once drained, `polaris topics deisolate` again.

## Audit reconstruction

Every isolation change writes an `audit_records` row. To reconstruct
the full lifecycle of a triple:

```bash
polaris audit list \
  --action topics.isolate,topics.deisolate \
  --project storefront \
  --since 2026-05-01T00:00:00Z
```

The `before` / `after` snapshots on the audit rows carry the full
shape of the affected `topic_isolations` row at the time of the
mutation. No secret-resolved value ever appears in the snapshots (the
table has no secret-shaped columns; the snapshot generator carries
the row as-is).
