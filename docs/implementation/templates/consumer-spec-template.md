# Consumer SPEC: `<vendor>` v`<N>`

> Every destination consumer ships a `SPEC.md` at `sync/destinations/<vendor>/<version>/SPEC.md` filled from this template. The SPEC is the durable artifact that survives across versions — when v2 is created, v1's SPEC remains for migration reference.

## Vendor

- **Name:** e.g., Meta Conversions API
- **API version this consumer targets:** e.g., `v18.0`
- **Documentation:** link to the vendor's official API docs at the version this consumer implements against
- **Auth scheme:** e.g., Bearer access token, OAuth2 client credentials, vendor-specific signed request
- **Base URL(s):** production endpoint(s); list any region-specific variants

## Supported canonical events

List the canonical event names this consumer handles. Events not listed are not delivered.

```text
payment.approved
checkout.started
subscription.renewed
```

For clarity, list events the consumer explicitly does not handle:

```text
identity.linked        not a vendor-relevant event
polaris.diagnostics.*  internal-only
```

## Field mapping

One subsection per canonical event. Each subsection is a table mapping canonical fields to vendor payload fields, with the normalization primitive used for each.

### `payment.approved` → `<vendor event>`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | direct; serves as vendor dedupe key |
| `occurred_at` | `event_time` | `timestamp.toEpochSeconds` | vendor wants seconds, not ms |
| `identity.customer_id` | `user_data.external_id[0]` | `hashing.sha256` | always-hashed |
| `context.email_hash` | `user_data.em[0]` | none | already hashed at envelope level |
| `context.phone_e164` | `user_data.ph[0]` | `phone.e164Sha256` | hashed at this stage |
| `properties.amount` | `custom_data.value` | minor-unit conversion | vendor wants decimal |
| `properties.currency` | `custom_data.currency` | none | ISO 4217 |
| `properties.order_id` | `custom_data.order_id` | none | direct |

Repeat for every canonical event the consumer handles.

## Normalization rules

Reference primitives from `packages/shared-destination-normalize/`. List any consumer-specific normalizations that are not in the shared package.

Shared primitives used:

```text
email       normalize.email.lowercaseTrimSha256
phone       normalize.phone.e164Sha256
externalId  normalize.externalId.trimSha256
timestamp   normalize.timestamp.epochSeconds
currency    normalize.currency.minorToDecimal
hashing     normalize.hashing.sha256
```

Consumer-specific rules (if any):

- `<rule>` — describe and justify, e.g., "Meta requires `action_source = 'website'` for web-origin events and `'app'` for mobile; consumer infers from `source.type`."

## Vendor dedupe

How Polaris identity maps to the vendor's idempotency mechanism.

- **Vendor dedupe field:** e.g., `event_id` (Meta, TikTok), `transaction_id` (GA4 purchase events)
- **Polaris source field:** typically the canonical `event_id` (UUIDv7)
- **Stability across retries:** confirmed — the destination runtime (P9-001) preserves the delivery key across retry attempts.

## Consent slot mapping

How canonical consent fields translate to vendor consent slots. The platform default is "absent canonical consent → `true` at the vendor slot" (matches Polaris default-capture principle and vendor "missing is more strict than `true`" interpretation).

| Canonical | Vendor field | Default when canonical absent |
|---|---|---|
| `consent.marketing` | `data_processing_options[0]` | `true` |
| `consent.personalization` | `<vendor field>` | `true` |
| `consent.analytics` | not used by vendor | n/a |

Document any deviation from the absent-as-`true` default and the reason.

## Error class table

How vendor responses map to the consumer's retry / DLQ / permanent classification.

| Vendor signal | Classification | Behavior |
|---|---|---|
| HTTP 200, body `success: true` | success | write delivery record |
| HTTP 200, body `success: false`, code `auth_expired` | retryable | refresh credential, retry |
| HTTP 4xx, validation error class | permanent | route to DLQ with vendor error preserved |
| HTTP 429 | rate-limited | respect `Retry-After` if present; otherwise exponential backoff |
| HTTP 5xx | retryable | exponential backoff with jitter |
| network error / timeout | retryable | exponential backoff with jitter |

DLQ payloads include vendor error class and last response metadata; never include credentials.

## Rate limit profile

- **Vendor-published limits:** e.g., "100 events/second/account" — link to vendor doc
- **Consumer defaults:**
  - `batch_size`: `<N>`
  - `max_inflight`: `<N>`
  - `request_timeout_ms`: `<N>`
  - `retry_backoff_base_ms`: `<N>`
  - `retry_backoff_max_s`: `<N>`
  - `max_attempts`: `<N>`

These defaults are tunable per destination instance via PostgreSQL runtime knobs (see [Destinations / Destination Instances](../../architecture/06-destinations.md)).

## Identity field mapping detail

If the consumer's identity slot model is complex (Meta CAPI's `user_data` shape, TikTok's hashed identifiers, etc.), describe the full mapping here with examples. Skip if straightforward.

## Test fixtures

Each canonical event the consumer handles has at least one golden fixture pair:

```text
sync/destinations/<vendor>/<version>/test/fixtures/<event>.input.json    canonical event
sync/destinations/<vendor>/<version>/test/fixtures/<event>.output.json   vendor payload after normalize+map
```

Fixtures are deterministic and used by contract tests. The vendor delivery step (network) is not exercised in unit tests; integration tests against vendor sandbox endpoints are documented separately.

## Known divergences from canonical

Document places where vendor semantics differ from canonical and how the mapping resolves them.

Examples:

- "Vendor only accepts email hashes in lowercase hex; canonical `context.email_hash` is already lowercase hex (verified at envelope validation)."
- "Vendor's `purchase` event requires a `currency` field; if canonical event omits it, the mapper defaults to `USD` and emits a warning metric `<consumer>_default_currency_used_total{project_id, environment}`."
- "Vendor uses milliseconds for timestamps in `<event>` but seconds for everything else; mapper handles this asymmetry per-event."

## Vendor API changelog

```text
Vendor release notes URL:                  <link>
Vendor API version this consumer targets:  <vN>
Last vendor-side compatibility check:      <YYYY-MM-DD>
```

When the vendor breaks compatibility, a new consumer version is required. Document the trigger in the migration notes section below.

## Migration notes (only for vN where N > 1)

When this is not the first version, document:

- **Breaking changes from the previous version** — field mapping changes, normalization changes, error-class reclassifications, anything semantic.
- **Operator migration path** — per-instance `consumer_version` flip via CLI; cleanly drain v(N-1) offsets before vN starts (see [Destinations / Version coexistence and migration](../../architecture/06-destinations.md)).
- **Why dual-write was not used** — Polaris does not allow hot dual-write of the same event. Migration is per-instance, operator-driven.
- **Backfill / replay requirements** — if vN's output is materially different and existing vendor-side analytics depend on it, document the replay workflow that re-delivers historical events under vN.
