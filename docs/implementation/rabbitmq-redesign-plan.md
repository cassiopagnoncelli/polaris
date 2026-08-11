# RabbitMQ Redesign Plan

Status: **approved direction, not started**
Decision: replace Redpanda with RabbitMQ as the end-to-end event transport.
Date: 2026-08-10
Owner: Cassio

This is a redesign of the transport layer, not a driver swap. The plan is
sequenced so the highest-risk, highest-value work lands first and so the
system stays green (tests + acceptance) at every gate.

---

## 1. Target architecture

RabbitMQ **4.1.x**, two queue types with distinct roles:

| Role | RabbitMQ construct | Replaces |
|---|---|---|
| Canonical event log (`raw.events`, `identity.events`, `enriched.events`, `attribution.events`, `analytics.events`, `session.events`) | **Super streams** (partitioned streams, age-based retention) | Redpanda topics |
| Per-project isolation (`raw.events.<project_id>`) | Dedicated super stream, resolver-selected | Dedicated topic |
| Retry with backoff (per consumer/processor) | **Quorum queue** `retry.<name>` with per-message TTL + DLX → `redeliver.<name>` | Retry topics |
| Dead letters | **Quorum queue** `dlq.<name>` + existing Postgres `dlq_records` / `processor_dlq_records` (unchanged) | DLQ topics |
| ClickHouse ingestion | New consumer service `consumers/clickhouse-sink` → batched inserts into a `Null`-engine staging table; existing MVs unchanged | ClickHouse Kafka Engine |
| Replay source | Stream attach by `x-stream-offset` (timestamp), read to window end | `seek` + offset-range reads |
| Consumer checkpoint | Postgres `transport_checkpoints (group_name, stream, partition, last_offset)` — authoritative | Kafka committed offsets |

### Protocol decision: AMQP 0-9-1 first

All v1 clients use **amqplib** (AMQP 0-9-1) — battle-tested, boring:

- Streams are consumed via `x-queue-type: stream` + `x-stream-offset`
  (offset, timestamp, `first`, `next`) + prefetch/ack. All log semantics
  Polaris needs are reachable over AMQP.
- Publishing uses confirm channels (≈ `acks=all`).
- The native stream protocol client (`rabbitmq-stream-js-client`) is **not**
  used in v1: it is far less battle-tested than amqplib and its main
  additions (server-side offset tracking, SAC groups, higher throughput)
  have v1 substitutes (Postgres checkpoints, static assignment). It remains
  the designated escape hatch if R3's throughput gate fails.

### Partitioning and ordering

- Super streams are declared day one (exchange + partition streams
  `<family>-0..N-1`), so a later native-client/SAC adoption needs no
  renaming.
- The producer keeps the existing partition-key derivation
  (`shared-kafka/partition-key.ts`, unchanged) and owns the hash:
  `hash(partition_key) % N` → publish to the super stream exchange with
  routing key `"<K>"`. Same ordering guarantee as today: per-identity order
  within a partition.
- Partition count is fixed at declaration (default 3 local; prod counts are
  an open decision). Repartitioning = new family version — same operational
  reality as Kafka.
- Consumers: **static partition assignment** in v1. Each instance is
  configured with its partition set (`POLARIS_ASSIGNED_PARTITIONS`); one
  reader per partition stream; checkpoint after handler success. No group
  rebalancing — an ops-visible simplification, documented in runbooks.
  Kafka-style dynamic groups return later via native-client SAC if needed.

### Delivery guarantees (unchanged posture)

At-least-once end to end: publisher confirms + checkpoint-after-process.
Duplicate absorption stays where it already is — ingester 15-min dedupe
window, destination dedupe window, ClickHouse ReplacingMergeTree/argMax.
No layer today assumes exactly-once transport; that is what makes this
migration tractable.

### Retry/DLQ (destinations and processors)

Today: retry topics with consumer-side delay. New model is native and
strictly better:

1. Handler fails → republish to `retry.<name>` (quorum) with
   `expiration = backoff(attempt)` and the existing
   `polaris-retry-*` headers.
2. TTL expiry dead-letters via DLX into `redeliver.<name>` (quorum).
3. The consumer consumes its partition streams **and** its redeliver queue.
4. Attempts exhausted → `dlq.<name>` + Postgres DLQ row (existing writers
   unchanged). CLI `dlq retry` republishes to `redeliver.<name>`.

### ClickHouse ingestion

No ClickHouse engine exists for streams (and the AMQP engine loses
offsets), so ingestion becomes a Polaris-owned consumer:

- `consumers/clickhouse-sink/v1`: consumes `analytics.events` partitions,
  batches by size/time, `INSERT ... FORMAT JSONEachRow` into
  `analytics_events_queue` re-declared as **`ENGINE = Null`** with the
  same columns plus explicit `_topic/_partition/_offset` (previously
  Kafka-engine virtuals; now stamped by the sink: stream name, partition
  index, stream offset — fits `UInt64`).
- Both MVs (`21_`, `31_`) and `analytics_ingest_log` survive with trivial
  edits; the SQL transformation layer stays in SQL.
- Checkpoint after successful insert ⇒ at-least-once; ReplacingMergeTree
  dedupes — identical to today's recovery semantics, now in our code
  instead of the Kafka engine's.
- New gauge `polaris_clickhouse_sink_lag_seconds` replaces the planned
  Kafka-engine lag metric; alerts rewired.

### Replay

- Planner (`shared-replay/planner.ts`) is time-windowed and
  transport-agnostic — **unchanged**.
- `offset-range-reader.ts` → `stream-range-reader.ts`: attach at
  `x-stream-offset: {timestamp: window_from}`, emit until message
  timestamp > `window_to` or tail idle-timeout. This deletes the
  time→offset resolution step (`kafka.admin()` in
  `apps/polaris-cli/src/commands/replay/execute.ts`) entirely.
- Timestamp attach is chunk-granular ⇒ slight over-read at window start;
  absorbed by the same dedupe layers that absorb today's HWM clamp.
- Replay reads still use no group/checkpoint state — live consumers
  undisturbed, unchanged guarantee.
- Replay suppression, opt-in gates, audit — unchanged (only kafkajs types
  swapped for the port's types).

---

## 2. Workstreams

| # | Workstream | Contents | Size | Gate |
|---|---|---|---|---|
| **R0** | Port abstraction (do this regardless of broker) | New `@polaris/shared-transport`: broker-neutral `PolarisMessage`, producer/consumer/driver interfaces; wrap current KafkaJS impl as the first driver; migrate all services off KafkaJS types (`EachMessagePayload`, `.raw`, ~20 files); ADR | L (3–4d) | Full tests + acceptance green **still on Redpanda** |
| **R1** | Local infra + config | Compose service `rabbitmq:4.1-management` (+ `rabbitmq_stream`, `rabbitmq_prometheus`), ports 5672/15672/5552/15692, healthcheck; `scripts/rabbitmq-provision.mjs` (super streams, retention policies, retry/redeliver/dlq queues — replaces topic auto-creation); `shared-config` `rabbitmq.ts` schema (`POLARIS_RABBITMQ_URL`, `_MANAGEMENT_URL`, TLS, prefetch, partition map); env examples | S (1d) | `make up` + provision idempotent |
| **R2** | RabbitMQ driver | amqplib driver for the R0 port: confirm-channel producer with client-side partition hashing; stream consumer (per-partition channels, prefetch, ack); Postgres `transport_checkpoints` migration + store; retry/redeliver/DLQ helpers; headers mapping (AMQP headers table); hooks/metrics parity | L (3–5d) | Driver test suite + smoke vs live broker |
| **R3** | Spine cutover | `ingester-api` + 5 processors switch driver; static partition assignment wiring; `processor_runs.last_offset` stays informational; **throughput gate**: sustained publish/consume benchmark vs current acceptance baseline | M (2–3d) | Acceptance suite green on RabbitMQ |
| **R4** | ClickHouse sink | `consumers/clickhouse-sink/v1`; SQL migration `10_` → Null engine + explicit lineage columns, `21_`/`31_`/`20_` touch-ups, `roles/01_grants.sql` Kafka grant removal; rebuild runbook update | M (2–3d) | CH counts match producer counts in acceptance |
| **R5** | Destinations | `shared-destinations/runtime.ts` onto port + new retry topology; 5 consumers; `shared-processor/dlq.ts`; CLI `dlq`/`processors dlq` commands (Postgres paths unchanged, republish targets redeliver queues) | M (2–3d) | DLQ acceptance scenarios green |
| **R6** | Replay | `stream-range-reader`, executor wiring, CLI `replay execute` (drop admin offset resolution), isolation-cutover flow against dedicated super streams | M (2–3d) | Replay acceptance scenario green |
| **R7** | Observability | Prometheus scrape of broker; `polaris-redpanda.json` → `polaris-rabbitmq.json` (stream bytes, publish rates, queue depths, consumer presence); alert rules swap broker-level rules; `polaris_processor_lag_ms_last` (timestamp-based) survives as the primary lag signal — per-project dashboards keep working | S–M (1–2d) | Dashboards render, alerts fire in smoke |
| **R8** | Docs + runbooks | Rewrite `03-redpanda-topics.md` → `03-rabbitmq-streams.md`; touch 00/04/05/07/08/09/11; rewrite runbooks: publish-failures, dlq-growth, dlq-triage ×2, destination-dlq-triage, replay-stuck, processor-lag, clickhouse-ingestion-lag, topic-isolation-cutover; getting-started, ci, config-reference, backup-and-retention, SLOs, alerts, dashboards | M (2d) | Doc grep for `redpanda|kafka` returns only historical notes |
| **R9** | Teardown | Delete `shared-kafka`, `kafkajs` dep, redpanda compose service + config schema + dashboard + env keys; lockfile regen | S (0.5d) | Repo-wide grep clean; CI green |

**Total ≈ 17–25 engineer-days serial.** R3–R7 parallelize across workers
after R2 lands (worktree isolation rules apply per standing workflow).
R0 is independently valuable and is the hybrid off-ramp: after R0, a
partial adoption (e.g. RabbitMQ for destinations only) is a config choice,
not a rewrite.

### Sequencing

```
R0 ──► R1 ──► R2 ──► R3 ──► R4 ─┐
                      ├──► R5 ──┼──► R8 ──► R9
                      └──► R6 ──┘
                      └──► R7 (anytime after R3)
```

---

## 3. Cutover strategy

Assumption: **pre-GA, no production traffic** (release-candidate checklist
still open). Therefore: per-workstream big-bang on `main`, gated by the
acceptance suite; no dual-write phase.

If production traffic exists before R3 lands, insert a shadow phase:
dual-publish `raw.events` to both brokers from the ingester (port makes
this a two-driver fan-out), compare ClickHouse counts for 48h, then flip
consumers family-by-family.

---

## 4. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| AMQP throughput ceiling on streams (well below native stream protocol) | High | Per-partition channels; R3 benchmark gate against acceptance baseline; native-client escape hatch confirmed viable before R2 exits |
| `rabbitmq-stream-js-client` immaturity (if escape hatch needed) | Medium | Not in v1 path; evaluate only on R3 gate failure |
| Loss of consumer-group rebalancing | Medium | Static assignment is deliberate v1 simplicity; runbook for scale-out; SAC via native client later |
| ClickHouse delivery now Polaris-owned code | Medium | Null-table + MV design keeps transform in SQL; ReplacingMergeTree absorbs redelivery; sink is the smallest possible service |
| Ops unfamiliarity: RabbitMQ clustering (quorum + stream replication) vs single-binary Redpanda | Medium | R8 runbooks; management UI is a partial offset; prod topology doc before GA |
| Timestamp-attach over-read at replay window start | Low | Existing dedupe layers; same class as today's HWM clamp |
| Fixed partition counts | Low | Same as Kafka in practice; document family-version bump procedure |

---

## 5. What does not change

SDKs (`node-sdk`, `web-sdk` — HTTP to ingester), ingester HTTP contract,
event envelope + `polaris-*` headers + serialization, partition-key
derivation, Postgres DLQ record schemas (`source_offset text ≤64` holds a
`uint64`), replay planner + risk model, replay suppression/opt-in gates,
dedupe windows, `control-plane-api`, per-project metric labels and the
processor-lag alerting signal, CI shape.

---

## 6. Open decisions

| # | Decision | Default |
|---|---|---|
| 1 | Prod partition counts per family | `raw.events` 6, others 3 |
| 2 | Sink placement | `consumers/clickhouse-sink/v1` |
| 3 | Package name | new `@polaris/shared-transport`, `shared-kafka` deleted at R9 |
| 4 | Dual-write phase | No (pre-GA assumption) — confirm |
| 5 | Broker HA target for prod (3-node quorum/stream replication) | 3-node, RF=3, mirrors current prod posture |
