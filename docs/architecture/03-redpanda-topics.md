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

## Dedicated Topic Escape Hatch

Dedicated topics may be introduced only for concrete operational reasons:

- unusually high volume
- different retention requirements
- stricter access control
- compliance/privacy constraints
- replay isolation
- consumer blast-radius reduction

Dedicated topics are an exception, not the default.

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

