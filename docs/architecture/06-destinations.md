# Destinations

## Role

Destination consumers are protocol translators.

They map canonical Polaris events into destination-specific payloads. They do not own canonical business semantics.

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

## Mapping Semantics

Destination mappings are code-only semantic logic.

Rules:

- Canonical-to-vendor mapping behavior lives in versioned consumer code.
- PostgreSQL does not define mapping semantics.
- Mapping changes require code review, tests, and deploy.
- Consumer versions define supported mappings through code/tests.
- A CLI may inspect/export mapping capabilities from code, but mappings are not mutable runtime data.

Example:

```text
consumers/meta-capi/v1/mappers/payment-approved.ts
consumers/meta-capi/v1/mappers/checkout-started.ts
consumers/ga4/v1/mappers/payment-approved.ts
```

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

Each consumer owns retry and DLQ topics:

```text
meta-capi.retry
meta-capi.dlq
ga4.retry
ga4.dlq
tiktok.retry
tiktok.dlq
```

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
