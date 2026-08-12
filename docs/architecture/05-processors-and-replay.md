# Processors and Replay

## Processor Model

Processors are independent, versioned TypeScript services.

Example layout:

```text
processors/
  geoip-enricher/
    v1/
    v2/
  identity-resolver/
    v1/
    v2/
  attribution-engine/
    v1/
  sessionizer/
    v1/
```

Processors consume from one topic and emit derived events to another topic. They do not mutate existing events.

## Processor Versioning

Polaris uses immutable semantic processor versions.

Rules:

- Released processor versions are immutable in semantic behavior.
- Any output-changing behavior requires a new processor version.
- Released versions include a manifest and changelog.
- Derived events include processor metadata.
- Processor runs are tracked in PostgreSQL.
- Replay jobs target exact processor versions.

Allowed changes inside a released version:

- security fix
- dependency patch
- observability improvement
- non-semantic bug fix with explicit changelog

Required new version:

- changed mapping logic
- changed identity rule
- changed attribution rule
- changed output schema
- changed filtering behavior
- changed enrichment semantics

## Processor Metadata

Derived events include metadata:

```json
{
  "processor": {
    "name": "identity-resolver",
    "version": "v2",
    "run_id": "019ff156-5d5c-70d3-a159-09c103a9a134"
  },
  "pipeline": {
    "version": "2026.05"
  }
}
```

`run_id` is a UUIDv7 identifying a row in `processor_runs`. The processor
allocates it at boot and registers the row before the first message is
handled, so the id on a derived event always names a run an operator can look
up (`polaris processors runs show <run_id>`, or the Processors page in the
admin panel).

Registration is deliberately non-fatal: a processor whose control-plane
database is unreachable keeps consuming and logs a warning. The run id stays
stable and the row is inserted on the next attempt, so a short outage costs
the record its start, not the pipeline its throughput.

Runtime traceability includes:

```text
raw event
  -> processor name/version
  -> git sha
  -> config hash
  -> runtime settings hash
  -> processor run id
  -> derived event
  -> replay job, if applicable
```

## Processor Configuration

Processor transformation semantics live in versioned code.

PostgreSQL may store runtime operational settings:

- enabled/disabled state
- project/environment activation
- input topic
- output topic
- consumer group
- batch size
- max concurrency
- non-semantic operational TTLs

PostgreSQL must not store semantic transformation rules.

### Activation

`processor_activations` is read at runtime, per message, once the envelope's
`project_id` and `environment` are known — processors consume shared streams,
so scope is a property of the event, not of the process.

- An explicit `disabled` row stops that processor from acting on that scope.
- Anything else — an `enabled` row, or no row — lets the event through.

Absence means allowed on purpose. Default-deny would make a new project's
events vanish until someone remembered to insert a row per processor, which is
silent data loss dressed up as configuration. Disable is the operator action
that carries intent, so disable is what the runtime enforces; `enable` is the
audited way to undo one.

A skipped event is acknowledged and counted as
`polaris_processor_events_skipped_total{reason="processor_disabled"}`. It is
not retried and not dead-lettered: an operator turning a processor off is a
decision, not a failure.

Answers are cached for ten seconds, so a disable takes hold within about that
long without a redeploy. If PostgreSQL is unreachable the gate serves its last
answer, or allows the event when it has none — losing the control plane must
not silently stop the pipeline.

If changing a setting can change emitted event meaning, fields, identity links, attribution outcomes, filtering behavior, or output schema, the setting is semantic. Semantic-changing settings must live in versioned processor code/config and require a new processor version.

## State Stores

Use:

```text
Redis       ephemeral TTL state
PostgreSQL durable runtime/control records
```

Redis examples:

- session windows
- dedupe windows
- attribution windows where non-authoritative
- temporary identity lookups

PostgreSQL examples:

- processor runs
- replay jobs
- replay attempts
- audit records
- runtime activation state
- authoritative per-identifier processor state (identity links, attribution chains)

### Choosing between them

No processor keeps working state in its own process. Both stores beat an
in-process map, and the choice between them is decided by the **shape of
the state**, not by which processor happens to own it:

| Question | Redis | PostgreSQL |
|---|---|---|
| Does the state have a natural expiry? | yes — expiry *is* the domain rule | no, or measured in months |
| Is losing it recoverable by replay? | yes | no, or not cheaply |
| Does anyone need to query it? | no | yes |
| Should its write share the consumer's checkpoint transaction? | cannot | can |

Worked examples, one on each side:

- **Session windows → Redis.** A session record must die at the
  inactivity window, so Redis key expiry is the rule itself rather than
  an approximation of it, and no sweeper is needed. Loss is tolerable
  because `session_id` derivation is deterministic — a replay from
  `raw.events` reproduces the same output.

- **Attribution touchpoint chains → PostgreSQL.** These have no natural
  expiry (attribution windows run 30–90 days), so a TTL store would hold
  an unbounded hot keyspace for months. They are also authoritative:
  losing a chain silently re-attributes a conversion rather than costing
  a bounded window. PostgreSQL bounds them, survives restarts, and makes
  them queryable, which is a capability operators otherwise lack.

The trap the table above is written to avoid is picking one store for
both out of a preference for uniformity. Redis for attribution is a
90-day TTL on an unbounded keyspace; PostgreSQL for sessions is a row
write per event on the platform's hottest path to hold state designed to
be thrown away.

### Failure mode

Externalising state means the store is on the hot path, and processors
whose state is authoritative **fail the message rather than degrade**.
Without the prior record the sessionizer cannot tell a continuation from
a new session, and the attribution engine cannot tell a first
observation from a continuation; guessing would emit a wrong
`session_id` or a duplicate `first_touch_assigned`. So a store outage
propagates: the checkpoint does not advance, the message is redelivered,
and the processor stalls rather than corrupting its output. `/ready`
drops with it so the pod stops claiming partitions it cannot serve.

This is deliberately the opposite of the ingester's dedupe store, which
swallows every Redis failure and continues — dedupe is a retry-storm
absorber, and losing it degrades nothing that matters.

## Identity Resolution

Canonical identity resolution uses an explicit-link graph.

Rules:

- Canonical merges only happen from authoritative links.
- Authoritative links include events that explicitly contain both identifiers, such as `anonymous_id + customer_id`.
- Reliable business identifiers may be treated as link-worthy only when documented.
- IP, user agent, timing, device traits, campaign proximity, and similar signals must not mutate the canonical graph.

Heuristics may later emit non-authoritative candidate events:

```text
identity.link_candidate.created
```

Heuristic linking is controlled by a dedicated config file and can be enabled/disabled explicitly. Candidate links must include confidence, reasons, processor version, and audit metadata.

## Replay Control Plane

Replay is a first-class platform capability, bounded by the operational retention window.

Rules:

- Replays are not ad hoc shell operations in normal use.
- Every replay is represented as a durable replay job in PostgreSQL.
- Replays are scoped by `project_id`, `environment`, topic, time window and/or offset range.
- Replays specify target processor/consumer/version.
- Replays record reason, requester, status, timestamps, and outcome.
- Destination sends are disabled by default during replay.
- External destination delivery during replay requires explicit opt-in.
- Replay jobs support dry runs.
- Replay jobs support approval gates for risky targets.
- Replay jobs preserve lineage between source events, processor versions, output topics, and derived events.
- ClickHouse projection rebuilds are replay/rebuild workflows, not manual one-off SQL.

### Replay Window

The practical replay window equals the retention of the source topic in RabbitMQ. With the v1 defaults, that is **90 days for `raw.events`** and shorter for derived topics.

Polaris does not promise replay beyond the operational retention window. Any incident requiring older replay is out of scope until object-storage raw archive exists. The principle is "replayability within the operational retention window" — not unbounded replay.

Replay job creation must reject targets older than the source topic's retention with reason `outside_retention_window`. The CLI surfaces the effective window when planning a replay.

Archive restore is future work. When it lands, it extends the same replay control plane rather than introducing a separate workflow.

The UI/admin API can come later, but the data model must not block it.

