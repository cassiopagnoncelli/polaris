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

## Event Catalog Layout

The event catalog is file-based and domain-folder organized:

```text
catalog/events/payment/approved.yaml
catalog/events/checkout/started.yaml
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
- Processors and consumers are not required to honor consent metadata initially.
- Producers remain responsible for deciding what they are allowed to collect.

Hard sensitive-data prohibitions are enforced separately. The ingester must reject or redact configured forbidden fields such as:

- raw passwords
- card numbers
- CVV/CVC
- private keys
- authorization headers
- session cookies
- raw secret tokens

These guardrails are security hygiene, not a full consent-management system.

