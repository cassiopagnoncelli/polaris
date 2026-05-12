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
    "run_id": "run_2026_05_11_001"
  },
  "pipeline": {
    "version": "2026.05"
  }
}
```

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

The practical replay window equals the retention of the source topic in Redpanda. With the v1 defaults, that is **90 days for `raw.events`** and shorter for derived topics.

Polaris does not promise replay beyond the operational retention window. Any incident requiring older replay is out of scope until object-storage raw archive exists. The principle is "replayability within the operational retention window" — not unbounded replay.

Replay job creation must reject targets older than the source topic's retention with reason `outside_retention_window`. The CLI surfaces the effective window when planning a replay.

Archive restore is future work. When it lands, it extends the same replay control plane rather than introducing a separate workflow.

The UI/admin API can come later, but the data model must not block it.

