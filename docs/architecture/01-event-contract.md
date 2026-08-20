# Event Contract

## Canonical Envelope

Polaris uses a rigid canonical platform envelope with schema-versioned event properties.

The top-level envelope is platform-owned. Unknown top-level fields are rejected.

Example:

```json
{
  "event_id": "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  "event": "payment.approved",
  "schema_version": 1,
  "project_id": "checkout",
  "environment": "production",
  "occurred_at": "2026-05-11T12:00:00.000Z",
  "ingested_at": "2026-05-11T12:00:01.120Z",
  "source": {
    "type": "backend",
    "id": "payments-api",
    "sdk": "node",
    "sdk_version": "1.0.0"
  },
  "identity": {
    "anonymous_id": null,
    "session_id": null,
    "customer_id": "cus_123",
    "device_id": null
  },
  "context": {
    "ip": "203.0.113.10",
    "user_agent": "Mozilla/5.0 ...",
    "locale": "pt-BR",
    "page": null,
    "campaign": null
  },
  "consent": {
    "analytics": true,
    "marketing": false,
    "personalization": true
  },
  "privacy": {
    "classification": "internal"
  },
  "properties": {
    "payment_id": "pay_123",
    "order_id": "ord_456",
    "amount": 12990,
    "currency": "BRL",
    "payment_method": "credit_card",
    "psp": "stripe"
  }
}
```

## Trusted Metadata

`project_id`, `environment`, trusted source metadata, and `ingested_at` are stamped by the ingester.

Producers do not send or override:

- `project_id`
- `environment`
- trusted `source.id`
- `ingested_at`

API keys are bound to project, environment, and source.

## Event Naming

Event names are registered lowercase dotted facts with optional namespace depth.

Rules:

- lowercase ASCII
- dot-separated
- each segment uses `snake_case`
- at least two segments
- describes a fact that happened, not a command
- no vendor names unless the event is explicitly about a vendor integration
- registered and owned in the event catalog

Examples:

```text
checkout.started
payment.approved
merchant.onboarding.completed
subscription.invoice.payment_failed
risk.review.approved
```

Bad examples:

```text
trackPurchase
metaPurchaseEvent
process_payment_now
stripe_webhook_received
```

`stripe_webhook_received` is only acceptable if the event is genuinely about the Stripe integration itself, not a canonical payment fact.

## Schema Governance

Normal events require:

- registered event name
- owner
- description
- lifecycle status
- `schema_version`
- code-backed Zod schema for `properties`

The ingester rejects normal events whose `properties` do not match the registered event schema.

Schema changes require code review and deploy. PostgreSQL must not redefine what an event means.

### Property-level style is owner-defined

The platform enforces envelope-level rules (lowercase dotted event names, snake_case segments, UUIDv7 event IDs, ISO 8601 UTC timestamps). Inside `properties`, conventions are event-owner discretion:

- Currency representation (minor units vs decimal, currency field placement) is owner choice.
- Nested objects vs flat fields is owner choice.
- ID shape (prefixed strings, raw UUIDs, integers) is owner choice, subject to producer-side consistency.
- Enum-vs-string is owner choice; enum values that grow should follow the schema evolution rules above.

The platform does not enforce a style guide on property authoring. Reviews catch obvious problems (PII in property names, vendor-specific terms leaking into canonical events). Otherwise, owners are trusted to keep their event family coherent.

## Schema Evolution

`schema_version` is a per-event-name integer. v1 and later versions coexist in the catalog. Producers send a specific `schema_version`; the ingester validates against that exact version's schema.

### In-place changes (no version bump)

Permitted within an existing `schema_version` only if every previously-valid event would remain valid under the new schema, and every previously-invalid event would remain invalid:

- adding an optional field with no default-driven behavior change
- widening a numeric range
- widening a string length cap
- relaxing a regex
- adding an allowed enum value, only if downstream consumers handle unknown enum values gracefully and the addition is documented in the catalog entry
- documentation, owner, or lifecycle-status changes

In-place changes still require PR review and a catalog entry update. Use them sparingly — when in doubt, bump.

### Required version bump

A new `schema_version` is required for any change that breaks validation, meaning, or downstream interpretation:

- removing a field
- renaming a field
- changing a field type
- narrowing a range, length cap, or regex
- changing semantic meaning of an existing field
- removing or renaming an enum value
- restructuring nested objects

When bumping, the previous version remains in the catalog with `lifecycle: deprecated` and a `sunset_at` date. Producers using the old version keep working until sunset. After sunset, the ingester rejects events with the deprecated `schema_version` and returns reason code `schema_version_sunset`.

### Coexistence rules

- Both versions are validated independently by the ingester.
- Both versions land in the same RabbitMQ topic with the canonical envelope.
- Processors and consumers must declare which `schema_version` values they handle. Events with unsupported versions are routed to the consumer's DLQ with reason `unsupported_schema_version`, not silently dropped.
- Golden fixtures exist per version.

### Sunset workflow

1. New version is released. Old version is marked `deprecated` with a `sunset_at` date (default: 90 days, configurable per event).
2. Producer-side migration happens during the deprecation window. SDK guidance and dashboards surface deprecated-version traffic.
3. After `sunset_at`, the ingester rejects the deprecated version.
4. The deprecated schema definition stays in the catalog for replay correctness — historical events in `raw.events` may still need it during the retention window.

### Envelope evolution

The top-level envelope evolves separately from event `properties`. Envelope changes are governed at the platform level, not per-event:

- additive envelope fields are allowed if validation remains backwards-compatible (the ingester still accepts old producers)
- removing or restructuring envelope fields requires a documented platform release note and a coordinated SDK update
- envelope changes never reuse `schema_version`; if a versioned envelope marker is ever needed, it lives in `platform.envelope_version` and is platform-stamped, not producer-supplied

## Event Catalog Layout

The event catalog is file-based and domain-folder organized:

```text
definitions/events/payment/approved.yaml
definitions/events/checkout/started.yaml
packages/shared-schemas/src/events/payment/approved.v1.ts
packages/shared-schemas/src/events/checkout/started.v1.ts
```

Generated indexes may be used by the CLI and ingester, but the source of semantic truth remains in files/code.

## Experimental Events

`experimental.*` events are allowed for fast prototyping.

Rules:

- must still use the canonical envelope
- may use loose `properties` validation initially
- must not feed production dashboards, durable destination mappings, or core attribution logic
- should have shorter retention or explicit cleanup policy
- promotion to a governed event requires registration and a Zod schema

## Privacy and Consent

Polaris records privacy and consent metadata but does not enforce consent in v1.

Rules:

- `consent` and `privacy` fields are informational metadata.
- Events are not rejected because consent fields are false.
- Processors are not required to honor consent metadata initially.
- Destination consumers may use consent fields when the vendor protocol requires them (e.g., signal mapping), but enforcement remains best-effort in v1.
- Producers remain responsible for deciding what they are allowed to collect.

## Forbidden-Field Policy

Hard sensitive-data prohibitions are enforced at ingestion through a two-tier code-backed policy.

The policy lives in `definitions/policy/forbidden-fields.ts` and is the single source of truth. PostgreSQL must not redefine it. Per-project overrides are file-backed, not runtime mutable.

### Principle: default-capture, narrow-reject

Polaris captures every event regardless of consent. The only categories that block capture at the platform level are `pii_card` (card data) and `pii_secret` (passwords, tokens, keys, session credentials, private keys). Everything else passes through by default.

The reasoning is operational: rejecting an event is a producer-side bug signal. We reject only when the field's mere presence indicates a producer mistake we want them to fix (a CVV in a payment event, a raw password in any event, a private key anywhere). Other PII (email, phone, IP, address, account numbers, names) flows through unchanged at the platform level. Projects in regulated environments may add redaction rules in their own policy override.

### Reject list (named fields only)

Fields whose mere presence indicates a producer bug. The entire event is rejected with reason code `forbidden_field_rejected`. The rejection response names the field path but never echoes the value.

Platform defaults are intentionally narrow — only named fields that strongly signal a producer bug:

```text
pii_card
  cvv, cvc, card_security_code
  card_number_full

pii_secret
  password, passwd, pwd
  authorization, authorization_header
  session_cookie, raw cookie blobs
  private_key, priv_key, PEM-encoded private key bodies
```

Pattern-based detection is **not** on the reject list. False positives on regex/entropy rules are common enough that dropping the event on a pattern hit is too aggressive for v1.

### Redact list

Fields where the producer can legitimately send the value but the raw form must not be stored, **and** fields where pattern-based detection flags potential PII or secret material. The field value is replaced in the canonical event with `"[REDACTED:<reason>]"` and the event continues through ingestion. The original value never appears in logs, retries, DLQs, audit records, or delivery records.

Platform defaults — named-field redactions:

```text
card_number      → keep first 6 / last 4 as separate fields if producer supplied them; raw value redacted with reason pii_card
```

Platform defaults — pattern-based detections (each match emits the metric `polaris_ingest_redacted_pattern_total{project_id, environment, reason, pattern}` so producer leaks are observable):

```text
Luhn-valid 13-19 digit PAN in any field other than the explicit card_number field   → reason pii_card
AWS access key signatures (AKIA + base32 pattern)                                    → reason pii_secret
GitHub token signatures (ghp_, gho_, ghu_, ghs_, ghr_ prefixes)                      → reason pii_secret
JWT three-segment base64url pattern in fields outside identity.*                     → reason pii_secret
Generic 32+ byte hex or base64 strings in unexpected fields                          → reason pii_secret
```

The redact-plus-metric pattern means a producer leaking secrets gets the leak stripped from the canonical event AND triggers an observable signal the platform team can route to the responsible producer. The event itself continues, so a single regex false positive does not drop customer behavior data.

Note: IBAN, bank account numbers, raw `email`, raw `phone`, and similar PII fields are **not** on the platform default redact list. Projects that need them redacted add the rule through a project override. This matches the default-capture principle: the platform captures; projects opt into stricter handling.

### Project overrides

Project override files at `definitions/policy/forbidden-fields.<project_id>.ts` may:

- add fields to the reject list (for project-specific producer bugs)
- add fields to the redact list (for project-specific regulatory or privacy policies, e.g., raw `email` or raw `phone` in a hashed-only project)
- not downgrade a platform reject entry to redact, and not remove a platform reject entry, without a documented exception note in the override file that names the field, the reason, and the reviewer

### Reason codes

Closed set, stable across versions:

```text
pii_card        full or partial card number
pii_account     bank account or IBAN
pii_secret      detected high-entropy secret
policy          listed by name in the project or platform policy
length          exceeds configured length cap
pattern_match   matched a configured pattern rule
```

### Policy change workflow

- Adding to either list: PR review.
- Removing from the reject list or moving an entry from reject to redact: PR review plus an explicit note in the policy file with rationale and date.
- The policy file is part of the catalog and is exported through the CLI for inspection.

### Redaction guarantees

- Redacted values must never be logged, even at debug level.
- Redaction happens before any structured log line is emitted for the event.
- DLQ and retry topics preserve the redacted form, not the original.
- The ingester's own metrics count redactions per field, never values.

These guardrails are security hygiene, not a full consent-management system.

## Customer Deletion (Deferred)

Polaris events are immutable, so a "delete this customer's data" request cannot be satisfied by mutating existing events. The pattern below is designed but not built in v1; it lands when a project actually requires it.

### Tombstone event

A canonical event signals a deletion request:

```text
customer.deletion_requested
```

Properties include `customer_id` (and optionally `anonymous_id` if the customer was anonymous-only) and a `reason` field. The event is emitted by the project responsible for the customer's identity authority — typically a backend triggered by a user action or operator workflow. The tombstone is itself an immutable event in `raw.events`.

### Deletion list service

A small service (or processor) consumes `customer.deletion_requested` events and maintains a deletion list keyed by canonical identifier. The list is persisted (PostgreSQL) and exposed to downstream consumers through:

- a processor-level filter that suppresses subsequent events for the deleted customer from derived topics
- a destination-consumer hook that refuses to send to vendors for customers on the list
- a ClickHouse-side filter applied to projection-rebuild jobs so historical analytics are scoped to non-deleted customers

### What "deletion" means in v1 of this pattern

- Future events for the customer do not propagate beyond `raw.events`.
- Historical events in `raw.events` remain. They age out with retention.
- Projection tables are rebuilt with the deletion filter applied; raw historical data is not retroactively scrubbed from `raw.events`.
- Destination vendors that already received the customer's events are not auto-purged; vendor-side deletion is a separate API integration per vendor.

This satisfies most operational definitions of "stop processing this customer" without retroactively rewriting immutable history. Stronger definitions (cryptographic shredding, retroactive raw-event scrubbing) are out of scope for v1.

### When to build

Defer until at least one internal project has a concrete deletion requirement. Design the tombstone schema and deletion-list service shape; do not implement the suppression hooks across processors/consumers until needed.

