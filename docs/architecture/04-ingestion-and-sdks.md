# Ingestion and SDKs

## Ingester Purpose

The Ingester API is the public event ingress service for frontend SDKs, backend SDKs, and trusted producers.

Initial stack:

```text
Node.js
TypeScript
Fastify
Zod
amqplib (via @polaris/bus)
RabbitMQ
Redis
PostgreSQL
```

## Ingester Responsibilities

The ingester does:

- API key authentication
- source/project/environment resolution
- schema validation
- canonical envelope construction
- client context (`context.ip`, `context.user_agent`) stamped from the connection for browser- and mobile-typed keys
- event size limits
- timestamp normalization
- event ID enforcement
- forbidden-field rejection/redaction
- short-window idempotency checks
- publication to RabbitMQ

The ingester must not do:

- GeoIP enrichment (it stamps the address; it never looks one up)
- identity resolution
- attribution logic
- fraud scoring
- profile stitching
- vendor API calls
- business workflows
- analytics aggregation

## Client Context Stamped From the Connection

A browser cannot know its own public address. Before this, every
direct-from-browser event reached `enrichment.geo` with `ip: null`
(`source: no_ip`) and reached Meta CAPI and TikTok without
`client_ip_address` — the signal existed only on the relay path, where a
first-party server observed the connection and stamped it. So the ingester
now stands in for the producer's edge, exactly as Segment's API does, and
fills `context.ip` and `context.user_agent` from the connection.

The rules, in full:

- **Only browser- and mobile-typed keys.** Eligibility reads the API key's
  `source.type`, never the producer-sent one — neither kind of client can
  know its own public address. `backend`, `server` and `internal` keys are
  never stamped: a server's own address is noise, and a relay's address
  stamped as the end user's would be worse than noise.
- **A producer-sent value always wins.** The stamp only fills `null`. This
  is what leaves the relay path untouched.
- **`context.ip: "0.0.0.0"` means "do not collect"** — Segment's convention,
  so a migrating producer keeps working. It is normalised to `null` on every
  key type, so the sentinel never reaches the store where the geo stage
  would treat it as an address to look up.
- **One address selection, no parsing.** `X-Forwarded-For` with an explicit
  trust depth, or the socket peer at depth `0`; the operator-facing rules
  are in
  [config-reference](../deployment/config-reference.md#client-context-the-address-and-the-user-agent).
  No user-agent parsing, no lookups — ingress stays thin (ADR-0001).

### Why this stays in `context` and does not move to `enrichment`

`context` is what the **producer observed**; `enrichment` is what **Polaris
derived**. Stamping the address here does not blur that line, because the
ingester is acting as the producer's own edge — the same role the
first-party relay plays on the other transport, writing into the same field.
`enrichment.geo` is the derived thing, and it is derived *from* this field.

This is worth stating plainly because the shape invites a later "fix":
moving `context.ip` into `enrichment` would give the same value two homes
depending on which transport delivered it, and every consumer would need to
read both.

The stamp runs before the forbidden-field policy and before catalog
validation, so a stamped value is judged exactly like a producer-sent one —
including its envelope limits. It does not reach the quarantine, which
snapshots the producer's raw payload, so a platform-observed address never
lands in a violation record.

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

Polaris uses short-window ingress idempotency plus mandatory downstream idempotency. Ingress dedupe is a retry-storm absorber, not the canonical idempotency layer.

### Ingress (retry-storm absorber)

- Dedupe by `event_id` within a short window.
- Default window: **15 minutes**.
- Redis is the expected store.
- Sized for retry storms (SDK reconnect, backend outbox replay), not for edge idempotency.
- Operational budget at 10k events/sec: roughly 9M keys live, manageable on a small Redis instance.
- Per-project window overrides are allowed via runtime config when a project documents a specific need.

### Idempotency-at-edge (opt-in extension)

A project may opt in to a longer dedupe window (up to 24 hours) when its producers cannot reliably deduplicate at the source. This is opt-in, not the default. Opt-in records the increased Redis footprint as an explicit operational cost and is reviewed alongside Redis sizing.

### Downstream (canonical)

Downstream idempotency is mandatory and remains the authoritative dedupe layer:

- Processor consumers must be idempotent, keyed on `event_id` plus processor version.
- Destination consumers must be idempotent, keyed on a stable destination delivery key.
- ClickHouse stores enough identifiers to support analytical dedupe through `ReplacingMergeTree` plus `argMax` query patterns.

No downstream component may assume the ingester removed all duplicates. Ingress dedupe shrinks the duplicate count under a retry storm; it does not promise uniqueness.

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
