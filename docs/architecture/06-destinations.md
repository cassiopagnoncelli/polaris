# Destinations

## Role

Destination consumers are vendor adapters. They turn canonical Polaris events into vendor-specific deliveries. They do not own canonical business semantics.

Calling them "protocol translators" understates the work. Vendor adapters do three distinct things in v1:

1. **Normalize** canonical fields into the shape the vendor requires: hashing PII, lowercasing email, normalizing phone, formatting timestamps, converting currency units.
2. **Map** the normalized event into the vendor's payload schema. This is the pure protocol-translation stage.
3. **Deliver** the payload to the vendor API: auth, batching, retry, idempotency, rate limits, vendor dedupe fields, DLQs.

Each stage is independently versioned so a hashing-rule fix does not force a v2 of every mapper, and a mapping refresh does not force a redeploy of the delivery layer.

Examples:

```text
payment.approved -> Meta CAPI Purchase
payment.approved -> GA4 purchase
payment.approved -> TikTok CompletePayment
payment.approved -> Braze custom event
```

Vendor schemas must remain downstream-only.

## Consumer Layout

Destination consumers are independent and versioned:

```text
consumers/
  meta-capi/
    v1/
      normalize/
      mappers/
      deliver/
    v2/
  ga4/
    v1/
  tiktok/
    v1/
  braze/
    v1/
  reverse-etl/
    v1/
```

A shared normalization package owns vendor-agnostic primitives that several consumers need:

```text
packages/shared-destination-normalize/
  email.ts          lowercase + trim + sha256
  phone.ts          E.164 + sha256
  external-id.ts    trim + sha256
  currency.ts       minor-unit conversion
  timestamp.ts      epoch seconds, iso-8601 helpers
  hashing.ts        sha256 wrapper
```

Each consumer's `normalize/` directory composes from the shared package and adds vendor-specific rules (Meta's `em`/`ph`/`external_id` field requirements, TikTok's similar but distinct rules, GA4's measurement-protocol-specific shape).

## Four Stages

### Routing gate

The gate runs first and answers a question the other three stages assume has already been settled: is this event **for this destination instance at all?**

Before it existed, every event that reached a consumer was normalized, mapped and delivered. A vendor that only cared about purchases still received page views, and the only place to refuse them was the mapper — which put a routing decision inside vendor-specific code, made "why did this event reach Braze?" a code-reading exercise, and recorded the refusal as a mapping *failure*.

The gate is three checks in a fixed order:

    subscription  ->  property filters  ->  consent  ->  (normalize)

Order does not change **which** events pass — all three must pass — but it decides the **reason** recorded for those that do not, and the reason is the whole operational value of the row. An event that is both unsubscribed and consent-denied is reported as unsubscribed, because that is the fact an operator can act on.

Rules:

- The gate is **configuration, not code**: it reads the `routing` key from both config planes, in the precedence order of `project-config-plan.md` §3.3 — `project_config[namespace].routing`, then `destinations.config.routing`, the instance winning. The project slice comes through the same cache-only `peek` seam the deliverer uses, resolved once per event and shared between them so a config change landing mid-batch cannot hand the two different values.
- Precedence merges **per section**. An instance that declares only `subscriptions` narrows which events it wants while still inheriting the project's filters and consent requirements; replacing the whole block would let a subscription override silently discard a project-wide consent requirement. A section declared at both levels is taken from the instance entire, because unioning would let the project widen what an instance asked to narrow.
- **Absent or malformed configuration subscribes to everything.** An unconfigured project behaves exactly as it did before the gate existed, which is what makes it safe to land ahead of the vendor cutovers. Degrading open is safe here for one specific reason: the gate can only ever *subtract* deliveries, and normalization still applies the vendor's declared consent independently — so a broken config can never cause an event to be sent that would not have been sent anyway.
- **Filters address a closed set of roots**: `event`, `properties`, `context`, `profile`, `enrichment`. `identity` is deliberately absent — routing on who someone *is* rather than on what they *did* is both a privacy hazard and, with the profile plane one hop upstream, the wrong tool. Filter on a trait instead. A filter naming an unaddressable root is refused when the config is read, not silently unmatched at runtime.
- **Configuration may require more consent than the vendor declares, never less.** Instance requirements union with the descriptor's; a database row cannot undo a compliance decision made in versioned code.
- Comparison is **strictly typed**: `"1"` is not `1`. A coercing comparison would make a filter's behaviour depend on how a producer happened to serialise a value.
- A refusal records `skipped_filtered` with a **null `error_class`** and a detail naming the path and operator — never the envelope's value, which may be customer data on a widely readable row.

### Normalization

Normalization runs second. It takes the canonical event and produces a vendor-shaped intermediate that is safe to map.

Responsibilities:

- hashing PII per vendor rules
- trimming, casing, country/currency normalization
- timestamp formatting (epoch seconds vs ISO 8601)
- consent-signal mapping into the vendor's slot when the vendor requires one
- vendor-specific length caps and character restrictions

Rules:

- Normalization is **deterministic and stateless**. The same canonical event always produces the same normalized intermediate within a consumer version.
- Normalization runs **before logging**. No structured log line emits the un-normalized PII.
- Normalization is **independently versioned** from mappers. Bumping a hashing rule is `normalize/v1 -> normalize/v2`, not the whole consumer version.
- Normalization **never calls external services**. It is pure data transform.

### Mapping

Mapping takes the normalized intermediate and produces the vendor's payload schema for a specific event name and consumer version.

```text
sync/destinations/meta-capi/v1/mappers/payment-approved.ts
sync/destinations/meta-capi/v1/mappers/checkout-started.ts
sync/destinations/ga4/v1/mappers/payment-approved.ts
```

Rules:

- One mapper per (canonical event name, consumer version).
- Mappers are pure functions from normalized intermediate to vendor payload.
- Mappers do not perform hashing or normalization. If a mapper needs hashed data, it reads it from the normalized intermediate.
- A mapper that wants to read raw PII is a bug.
- Mappers carry golden fixtures: canonical event in, vendor payload out.

### Delivery

Delivery takes vendor payloads and gets them to the vendor's API.

Responsibilities:

- vendor auth and token refresh
- batching, rate limits, retries
- idempotency: Polaris-side delivery key plus vendor dedupe field where supported
- DLQ routing on permanent failures
- delivery record writes
- vendor SDK lifecycle and error class mapping

Rules:

- Delivery is the **only stage** that talks to the network.
- Delivery uses a **vendor client adapter** per consumer that wraps auth and base-URL concerns. The adapter is also versioned independently when needed.
- Delivery never sees raw canonical events; it only sees vendor payloads from the mapper.
- Replay sends through delivery are disabled by default and require explicit opt-in.

## Mapping Semantics

Mapping semantics live in versioned consumer code.

Rules:

- Canonical-to-vendor mapping behavior lives in versioned consumer code.
- PostgreSQL does not define mapping semantics.
- Mapping changes require code review, tests, and deploy.
- Consumer versions define supported mappings through code/tests.
- A CLI may inspect/export mapping capabilities from code, but mappings are not mutable runtime data.

## SPEC.md per consumer version

Every per-vendor consumer ships a `SPEC.md` at `consumers/<vendor>/v<N>/SPEC.md`, filled from [the consumer SPEC template](../implementation/templates/consumer-spec-template.md). The SPEC is the durable artifact that survives across versions and is the starting point for any future redesign.

The SPEC covers:

- vendor name, API version targeted, auth scheme, base URL
- supported canonical events (and explicitly unsupported ones)
- per-event field mapping table with the normalization primitive per field
- vendor dedupe key
- consent slot mapping with absent-as-true default
- error class table (vendor signal → retry / DLQ / permanent classification)
- rate limit profile (vendor-published + consumer defaults)
- identity field mapping detail
- test fixture references
- known divergences from canonical
- vendor API changelog pointer
- migration notes (for `v(N>1)`)

When `v2` is created, `v1/SPEC.md` stays in place. The migration-notes section in `v2/SPEC.md` documents the breaking changes from `v1`.

## Destination Instances

PostgreSQL stores destination instance state and non-semantic operational settings.

Fields may include:

```text
destination_id
project_id
environment
consumer_name
consumer_version
credential_ref
status
rate_limit_profile
batch_size
timeout_ms
delivery_enabled
replay_delivery_policy
```

Runtime knobs may tune delivery behavior, but not semantic meaning.

### Version coexistence and migration

Two versions of the same consumer may exist in code simultaneously (e.g., `meta-capi/v1` and `meta-capi/v2`). Each destination instance points at exactly one version through `consumer_version`. There is no hot dual-write — at any moment, an instance's events are processed by exactly one version.

Migration model:

- Operator flips one destination instance at a time via the CLI (`polaris destinations set-version <destination_id> --version v2`).
- The instance's consumer cleanly drains the old version's offsets before the new version starts consuming.
- Multiple instances may run different versions during a rolling migration window.
- Mappings, normalization rules, and delivery behavior are versioned at the consumer level (see Three Stages); migration is the operator's deliberate decision per instance.

Dual-write (the same event delivered by both v1 and v2) is explicitly disallowed for v1. It produces vendor-side double-delivery that vendor dedupe fields don't always catch.

### Consent default when absent

If the canonical event does not include `consent` fields, normalize stages default each consent flag to `true` when mapping to vendor consent slots. Reason: most vendor APIs interpret "no consent signal" more conservatively (often refusing the event), so absent fields are treated as positive consent at the platform boundary. Producers opting into stricter consent signaling set the fields explicitly.

This default is per consumer-version normalize stage, not a platform-wide rule. A consumer that needs different default behavior for a specific vendor codifies that in its normalize stage and ships it as part of the version's contract.

## Fan-out

`analytics.events` is the shared canonical stream. Its producer, the analytics-projector, knows nothing about destinations — so nothing on the message says where it should go. The consumer decides.

Each destination consumer reads every message on the stream and delivers one copy per **active destination instance of its own vendor in the envelope's environment**. A vendor with no destination rows delivers nothing; that is the normal state of a consumer nobody has enabled, not an error, and it is counted as `polaris_destination_events_skipped_total{reason="no_active_destinations"}` rather than routed to a DLQ.

Two consequences worth stating:

- The `vendor` column on a `destinations` row must match the `vendor` in the consumer's manifest exactly. `webhook-sink` looks for `webhook`; a row created against `webhook-sink` is a row no consumer reads.
- One retryable failure redelivers the message for every target, not just the one that failed. The destination-side dedupe window, keyed on `(destination_id, delivery_key)`, is what stops the targets that already succeeded from receiving a second copy.

A `polaris-destination-id` header overrides the fan-out and pins the envelope to exactly one instance. That is the replay path: replayed traffic targets one named destination and must not splash across every instance that happens to be active now.

## Delivery Model

Destination consumers use reliable at-least-once delivery with Polaris-owned idempotency and vendor-specific best-effort dedupe.

Rules:

- Consumers own batching.
- Consumers own rate limits.
- Consumers own retries.
- Consumers own DLQs.
- Consumers own offset handling.
- Consumers write delivery records.
- Consumers are idempotent before sending whenever possible.
- Consumers generate stable destination delivery keys.
- Consumers pass vendor dedupe fields when supported.
- Polaris does not promise exactly-once delivery to external APIs.
- Destination replay sends are disabled unless explicitly enabled by replay policy.

Vendor-specific notes:

- Meta and TikTok integrations should map stable Polaris delivery IDs into vendor `event_id` fields where supported.
- GA4 purchase mappings should use stable `transaction_id` when available.
- Braze-style integrations should assume weak or no vendor event dedupe and rely more heavily on Polaris delivery records.

## Retry and DLQ Policy

Each consumer owns retry and DLQ topics, named after the consumer's component — the same names `POLARIS_COMPONENTS` declares, not the vendor and not the consumer version:

```text
meta-capi.retry
meta-capi.dlq
ga4.retry
ga4.dlq
tiktok.retry
tiktok.dlq
webhook-sink.retry
webhook-sink.dlq
```

The consumer version rides along as a message header. It is deliberately absent from the queue name: a publish to a queue the provisioner never declared is unroutable on the default exchange, and RabbitMQ drops it without raising anything, so a versioned DLQ name would turn every DLQ-bound failure into silence.

DLQ events must preserve:

- canonical event ID
- destination ID
- consumer name/version
- mapper/version information where applicable
- attempt count
- last error class
- last vendor response metadata
- timestamps

Secrets must never appear in retry, DLQ, delivery, or audit payloads.
