# Redpanda Topics

## Role

Redpanda is the canonical event transport backbone for Polaris.

Redpanda owns:

- canonical event transport
- immutable append-only event logs
- replay source
- consumer offset management
- topic retention
- future tiered storage or archive integration

Redpanda must not be used as RPC.

## Default Canonical Topics

Polaris uses shared canonical topics by default:

```text
raw.events
identity.events
enriched.events
attribution.events
analytics.events
```

All projects flow through these shared topics. Separation is provided by envelope fields, partition keys, schemas, processor configuration, and consumer filtering.

Shared topics are a deliberate trade-off that fits Polaris's internal posture (cross-project visibility is allowed by design). They keep ops simple, but they couple lag, retention, and consumer health across projects. The triggers below decide when a project graduates to a dedicated topic.

## Topic Isolation Triggers

A project moves to a dedicated topic when any of these is true and persists for at least one operational review cycle:

- **Volume share**: one project drives more than 25% of a shared topic's sustained throughput, or any single partition is repeatedly hot because of that project's identity key distribution.
- **Retention divergence**: the project requires a materially different retention than the shared default (for example, a 7-day compliance cap or a 365-day archive requirement). "Materially different" means a delta that would change Redpanda disk sizing or break the shared TTL contract.
- **Lag isolation**: the project's primary consumer cannot keep up with shared-topic offsets and is dragging end-to-end lag SLOs for unrelated projects.
- **Schema risk**: the project's experimental or high-cardinality event traffic would meaningfully degrade validation latency or skew metrics for unrelated projects.
- **Operational quarantine**: an incident requires temporarily isolating a project's traffic so other projects continue flowing.

A project moves back to shared topics when its trigger condition has been resolved for a documented period. Topic moves are CLI-driven and audited.

## Topic Families

Canonical topic names refer to a family, not a fixed concrete topic. Producers and consumers resolve the family to a concrete topic through the source registry.

```text
raw.events                 shared default
raw.events.<project_id>    dedicated, created on isolation
```

The resolver returns:

- `raw.events` for projects not currently isolated
- `raw.events.<project_id>` for projects with an active isolation record

Consumer groups subscribe through the family API. The `shared-kafka` package owns this resolution and exposes a stable interface to processor and consumer code so isolation is operational, not structural.

## Per-Project Observability

Per-project metrics are required from day one, not added when isolation is needed. Topic isolation triggers are observable only if the metrics exist.

Required labels on Redpanda metrics:

```text
project_id
environment
topic_family
concrete_topic
partition
```

Required dashboards before any project graduates to a dedicated topic:

- per-project share of shared-topic throughput
- per-project consumer lag against shared-topic offsets
- per-partition skew on shared topics, grouped by project_id
- per-project schema validation rate and error rate

These dashboards live in P10 alongside the broader observability work.

## Dedicated Topic Escape Hatch

Beyond the formal isolation triggers, dedicated topics may be introduced when an explicit decision is recorded for one of these reasons:

- consumer blast-radius reduction during a known-risky migration
- replay isolation when a replay would otherwise pollute the shared topic
- explicit security-perimeter requirements that override the default internal posture (rare; requires a written exception note)

Dedicated topics remain the exception. The default is shared.

## Partition Key

The default `raw.events` partition key is project/environment-scoped and identity-aware:

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

This preserves useful per-identity ordering while distributing anonymous/backend events reasonably.

## Retention

Initial retention policy:

```text
raw.events       90 days
derived topics   topic-specific, usually shorter
retry topics      until resolved according to operational policy
dlq topics        until resolved according to operational policy
```

Long-term historical analytics live in ClickHouse.

Long-term raw replay should eventually come from object storage archive, not indefinite Redpanda retention.

## Retry and DLQ Topics

Processors and consumers own their retry and DLQ topics.

Examples:

```text
geoip-enricher.retry
geoip-enricher.dlq
identity-resolver.retry
identity-resolver.dlq
meta-capi.retry
meta-capi.dlq
ga4.retry
ga4.dlq
```

Retries and DLQs must include enough metadata to diagnose source event, processor/consumer version, error class, attempts, and timestamps.

## Event Semantics

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

Commands, imperative workflows, and vendor-specific actions do not belong in canonical event topics.

