# Ingestion and SDKs

## Ingester Purpose

The Ingester API is the public event ingress service for frontend SDKs, backend SDKs, and trusted producers.

Initial stack:

```text
Node.js
TypeScript
Fastify
Zod
KafkaJS
Redpanda
Redis
PostgreSQL
```

## Ingester Responsibilities

The ingester does:

- API key authentication
- source/project/environment resolution
- schema validation
- canonical envelope construction
- event size limits
- timestamp normalization
- event ID enforcement
- forbidden-field rejection/redaction
- short-window idempotency checks
- publication to Redpanda

The ingester must not do:

- GeoIP enrichment
- identity resolution
- attribution logic
- fraud scoring
- profile stitching
- vendor API calls
- business workflows
- analytics aggregation

## Batch Failure Behavior

The ingester uses partial acceptance with per-event validation results.

Rules:

- Batch requests are validated event by event.
- Valid events are accepted and published.
- Invalid events are rejected individually.
- One invalid event does not block the rest of the batch.
- The API response returns per-event status.
- Rejected event responses include stable machine-readable reason codes.
- SDKs must not retry permanently invalid events.
- SDKs may retry transient failures.
- Invalid events are not published to `raw.events`.

Example response:

```json
{
  "accepted": [
    { "event_id": "evt_1", "status": "accepted" }
  ],
  "rejected": [
    {
      "event_id": "evt_2",
      "status": "rejected",
      "reason": "schema_validation_failed"
    }
  ]
}
```

## Deduplication

Polaris uses short-window ingress idempotency plus mandatory downstream idempotency.

Ingress:

- dedupe by `event_id`
- initial window: 24 hours
- Redis is the expected store
- intended to absorb SDK/backend retry storms

Downstream:

- processors must be idempotent
- destination consumers must be idempotent
- ClickHouse stores enough identifiers to support analytical dedupe

No downstream component may assume the ingester removed all duplicates.

## SDK Responsibility

Polaris SDKs are thin transport SDKs with identity/session helpers.

SDKs do:

- generate `event_id`
- persist `anonymous_id`
- manage `session_id`
- support `identify(customer_id)`
- batch events
- retry with backoff
- keep a short local queue
- send over HTTPS to the ingester
- capture basic context

SDKs do not:

- enrich events
- perform attribution
- resolve identity
- call vendors
- perform business workflows
- own schema governance
- autocapture clicks/forms/DOM content in v1

## Browser SDK

Browser SDKs should capture conservative context:

- page URL
- path
- referrer
- title
- locale
- user agent
- campaign params where configured

Browser identity and queue persistence are defined in the SDK standards:

```text
identity: first-party cookie + localStorage mirror + sessionStorage + memory fallback
queue: IndexedDB + localStorage + memory fallback
```

The Web SDK is offline-first and lifecycle-aware. It starts in eager flush mode for short visits, then switches to steady batching.

## Node SDK

The Node SDK is server-oriented:

- stable event IDs
- batching
- retry
- service/runtime context
- explicit identity values provided by caller

The Node SDK must not infer attribution or identity relationships.
