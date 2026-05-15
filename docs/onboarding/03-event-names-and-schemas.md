# Phase 3 — Pick event names and add a schema

Polaris enforces **strict schema governance**. Every governed event must:

1. Have a registered, lowercase dotted name in `catalog/events/`.
2. Have a code-backed Zod schema in
   `packages/shared-schemas/src/events/`.
3. Be registered with an owner, description, lifecycle, and
   `schema_version` in the catalog entry.

**The ingester rejects normal events whose `properties` do not match the
registered schema, and rejects events whose names are not registered at
all.** The full rules and rationale are in [Event Contract / Schema
Governance](../architecture/01-event-contract.md#schema-governance) and
[Event Contract / Event Naming](../architecture/01-event-contract.md#event-naming).
There is no "just send any JSON you want and we'll figure it out". Schema
changes are PR review + deploy, not PostgreSQL writes.

> **Why so strict?** Schemas are semantic platform truth. If PostgreSQL
> could redefine what `payment.approved` means, replay correctness
> evaporates and every downstream consumer ends up guessing. See
> [Control Plane / Design Position](../architecture/02-control-plane.md#design-position).

## Event-name rules (envelope-level, enforced everywhere)

The platform enforces these naming rules in the SDK, the ingester, and the
catalog:

- lowercase ASCII
- dot-separated, **at least two segments**
- each segment is `snake_case`
- at most 128 characters total
- describes a **fact that happened**, not a command
- no vendor names unless the event is genuinely about a vendor integration

Good:

```text
checkout.started
payment.approved
merchant.onboarding.completed
subscription.invoice.payment_failed
risk.review.approved
```

Bad:

```text
trackPurchase                  # camelCase, no dot
metaPurchaseEvent              # vendor name in a canonical event
process_payment_now            # command, not a fact
stripe_webhook_received        # vendor-shaped (acceptable ONLY if the event
                               # is genuinely about the Stripe integration)
```

The SDK rejects bad names *synchronously* before they enter the queue (see
`apps/polaris-cli/src/commands/keys/list.ts`'s sibling validation in
`@polaris/shared-schemas`; surfaced through the SDK as
`ValidationError: invalid_event_name`). The ingester applies the same
regex on the server side, so a producer that bypasses the SDK still hits
the same gate.

## Property-level style is owner-defined

Inside `properties`, conventions are *event-owner discretion*. The platform
does **not** enforce:

- currency representation (minor units vs decimal)
- nested objects vs flat fields
- ID shape (prefixed strings, raw UUIDs, integers)
- enum vs free string

Pick conventions that fit your domain and keep your event family coherent.
The reviewer will catch obvious problems (PII in property names, vendor
terms leaking into canonical events).

## The catalog layout

Two files per event, in lockstep:

```text
catalog/events/<domain>/<event>.v<n>.yaml
packages/shared-schemas/src/events/<domain>/<event>.v<n>.ts
```

Real example — `catalog/events/checkout/started.v1.yaml`:

```yaml
# Catalog entry: checkout.started v1 (ACTIVE)
name: checkout.started
schema_version: 1
domain: checkout
owner: commerce
description: >-
  Emitted when a customer enters the checkout flow with at least one
  cart line item.
lifecycle: active
since: "2026-01-20"
schema_module: "@polaris/shared-schemas/events/checkout/started.v1"
schema_export: checkoutStartedV1PropertiesSchema
```

The companion Zod schema sits at
`packages/shared-schemas/src/events/checkout/started.v1.ts` and exports
`checkoutStartedV1PropertiesSchema`. The ingester imports the schema by the
`schema_module` + `schema_export` pair and validates every `properties`
payload against it.

## Step 3.1 — Pick names

Sit down with your reviewer and write the **list of facts** your producer
will record. One name per fact. Use the rules above. Examples for a
storefront onboarding:

```text
catalog.product.viewed
catalog.search.performed
cart.item_added
cart.item_removed
checkout.started
checkout.completed
payment.approved
payment.failed
```

Each becomes one catalog YAML + one Zod schema file.

## Step 3.2 — Write the Zod schema

```ts
// packages/shared-schemas/src/events/checkout/started.v1.ts
import { z } from "zod";

export const checkoutStartedV1PropertiesSchema = z.object({
  cart_id: z.string().min(1),
  item_count: z.number().int().positive(),
  subtotal_minor: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

export type CheckoutStartedV1Properties = z.infer<
  typeof checkoutStartedV1PropertiesSchema
>;
```

Conventions:

- Required vs optional is explicit. The ingester treats the schema as the
  contract; producers that omit a required field get
  `invalid_properties`.
- Numbers, regexes, length caps: tighten where you can. False positives at
  the ingester are easier to fix than false negatives downstream.
- Stay within additive-safe territory if you can — see [Schema Evolution
  rules](../architecture/01-event-contract.md#schema-evolution) for what
  forces a `v2`.

## Step 3.3 — Register it in the catalog

```yaml
# catalog/events/checkout/started.v1.yaml
name: checkout.started
schema_version: 1
domain: checkout
owner: your-team
description: >-
  Emitted when a customer enters the checkout flow with at least one cart
  line item.
lifecycle: active
since: "2026-05-15"
schema_module: "@polaris/shared-schemas/events/checkout/started.v1"
schema_export: checkoutStartedV1PropertiesSchema
```

The `schema_module` value must resolve to the file you wrote in step 3.2,
and `schema_export` must match the exported binding.

## Step 3.4 — Open the PR

Open one PR with both files plus any owner-discretion property tests you
want to pin behavior. The schema reviewer signs off; the change deploys
when the ingester binary picks it up.

> **Tip.** Use `polaris schemas validate` (mentioned in [Control Plane /
> CLI-First Control Plane](../architecture/02-control-plane.md#cli-first-control-plane))
> if it exists in your release — it lints the catalog before the ingester
> picks it up. Otherwise, the CI gate on the PR enforces the same checks.

## Versioning a registered event

When you need to change the shape of an event:

- **No version bump** (additive only): documented in
  [Schema Evolution / In-place changes](../architecture/01-event-contract.md#in-place-changes-no-version-bump).
  Adding an optional field, widening a range, relaxing a regex, adding an
  enum value (when consumers handle unknowns) — all allowed inside the
  same `schema_version`.
- **Required `v2`** (breaking): renaming a field, removing a field,
  narrowing a type, restructuring. You write `.v2.yaml` + `.v2.ts`,
  mark v1 `lifecycle: deprecated` with a `sunset_at`, then migrate
  producers during the window. See [Schema Evolution / Required
  version bump](../architecture/01-event-contract.md#required-version-bump).

The ingester validates against *the exact `schema_version` the producer
sent*. Old and new versions coexist in the catalog until sunset.

## Experimental escape hatch

Truly prototype events can use the `experimental.*` namespace. They:

- still use the canonical envelope
- can use loose `properties` validation initially
- **must not** feed production dashboards, durable destination mappings,
  or core attribution logic
- should have shorter retention or explicit cleanup
- need full registration + a Zod schema before they can leave the prototype
  state

See [Event Contract / Experimental Events](../architecture/01-event-contract.md#experimental-events).
Treat the namespace as a temporary scaffold, not a long-term home.

## Done when

- `catalog/events/<domain>/<event>.v1.yaml` exists for every fact you
  intend to emit.
- `packages/shared-schemas/src/events/<domain>/<event>.v1.ts` exists and
  the export name matches the catalog's `schema_export`.
- The PR is merged and the ingester running in your target environment
  has picked up the new schema (talk to your operator if you are unsure).

## Next

[Phase 4 — Install the Web SDK](./04-install-web-sdk.md) (if you have a
browser surface), then [Phase 5 — Install the Node SDK](./05-install-node-sdk.md)
(if you have a backend surface). Most teams need both.
