# Consumer SPEC: `meta-capi` v1

> First real-vendor consumer of the destination runtime. Maps the canonical Polaris commerce event subset (`checkout.started`, `payment.approved`, `user.identified`) into Meta's Conversions API payload shape, hashes identifiers per Meta's requirements, and POSTs to `graph.facebook.com/<api_version>/<pixel_id>/events`. Future vendor consumers (GA4, TikTok, Braze) clone this directory shape — webhook-sink v1 (`sync/destinations/webhook-sink/v1/`) is the structural template, and this SPEC documents how a real vendor specialises it.

## Vendor

- **Name:** Meta Conversions API
- **API version this consumer targets:** `v22.0` (pinned in `src/descriptor-identity.ts` as `META_GRAPH_API_VERSION`)
- **Documentation:** [Marketing API / Conversions API](https://developers.facebook.com/docs/marketing-api/conversions-api/) at the targeted version
- **Auth scheme:** Long-lived access token passed as `?access_token=<token>` query parameter (Meta's documented contract for server-side CAPI; no separate Authorization header).
- **Base URL(s):** `https://graph.facebook.com/<api_version>/<pixel_id>/events`. The host is overridable via `POLARIS_META_CAPI_GRAPH_HOST` for staging endpoints; production is the canonical literal.

## Supported canonical events

```text
checkout.started       →  InitiateCheckout
payment.approved       →  Purchase
user.identified        →  Lead
signup.completed       →  CompleteRegistration
subscription.renewed   →  Subscribe
```

Events outside this set produce `mapped_failed` delivery records with `error_class='mapping'`. The runbook (`docs/operations/destination-dlq-triage.md`) covers the operator path; future minor versions will extend the matrix. Notable not-yet-supported events:

```text
support.ticket.opened  Meta has no canonical equivalent; never delivered
polaris.diagnostics.*  internal-only platform telemetry; never delivered
```

## Field mapping

### `checkout.started` → `InitiateCheckout`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | Vendor dedupe key; matches browser-pixel `eventID` for cross-channel dedupe |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | Meta requires Unix seconds, not ms; floor(ms/1000) |
| `context.page.url` | `event_source_url` | none | When present; absent → omitted |
| inferred | `action_source` | branch on app/page context | `app` when any `context.app_*` slot is populated; `website` when `context.page_url` is populated; otherwise `system_generated` |
| `identity.customer_id` | `user_data.external_id[0]` | `sha256(lowercased(trim(value)))` | Meta requires hash for external_id |
| `identity.email_sha256` | `user_data.em[0]` | (already hashed by normalize) | shared-destination-normalize handles email sha256 |
| `identity.phone_sha256` | `user_data.ph[0]` | (already hashed by normalize) | E.164 + sha256 |
| `identity.anonymous_id` | `user_data.anon_id` | `sha256` | passes anonymized id through hash |
| `context.ip` | `user_data.client_ip_address` | passthrough | Meta uses for ad-attribution match |
| `context.user_agent` | `user_data.client_user_agent` | passthrough | same |
| `properties.cart_id` | `custom_data.order_id` | none | Meta accepts arbitrary order_id |
| `properties.total` | `custom_data.value` | `minorToMajor(value, currency)` | Meta wants decimal; minor → major per ISO 4217 exponent |
| `properties.currency` | `custom_data.currency` | none | ISO 4217 alphabetic |
| `properties.items[].quantity` (sum) | `custom_data.num_items` | sum + integer-check | When present |

### `payment.approved` → `Purchase`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | dedupe key |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | seconds |
| `identity.*` | `user_data.*` | same as checkout | see above |
| `context.*` | `user_data.client_*` + `event_source_url` | same as checkout | see above |
| `properties.amount_minor` (or `amount`) | `custom_data.value` | `minorToMajor` | Falls back to `amount` for legacy producers |
| `properties.currency` | `custom_data.currency` | none | ISO 4217 |
| `properties.order_id` (or `transaction_id`) | `custom_data.order_id` | none | First-non-null wins |

### `user.identified` → `Lead`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | dedupe key |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | seconds |
| `identity.*` | `user_data.*` | same as checkout | see above |
| `context.*` | `user_data.client_*` + `event_source_url` | same as checkout | see above |

No `custom_data` is populated — `Lead` is a lightweight intent signal.

### `signup.completed` → `CompleteRegistration`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | dedupe key |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | seconds |
| `identity.*` | `user_data.*` | same as checkout | see above |
| `context.*` | `user_data.client_*` + `event_source_url` | same as checkout | see above |
| `properties.currency` | `custom_data.currency` | none | ISO 4217 |
| `properties.predicted_ltv_minor` | `custom_data.predicted_ltv` | `minorToMajor` | Optional. Only populated when both `currency` and `predicted_ltv_minor` are present |

### `subscription.renewed` → `Subscribe`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | dedupe key |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | seconds |
| `identity.*` | `user_data.*` | same as checkout | see above |
| `context.*` | `user_data.client_*` + `event_source_url` | same as checkout | see above |
| `properties.amount_minor` (or `amount`) | `custom_data.value` | `minorToMajor` | Falls back to `amount` for legacy producers |
| `properties.currency` | `custom_data.currency` | none | ISO 4217 |
| `properties.predicted_ltv_minor` | `custom_data.predicted_ltv` | `minorToMajor` | Optional |
| `properties.subscription_id` | `custom_data.order_id` | none | Stable per-cycle id on the renewal |

## Normalization rules

The shared `@polaris/shared-destination-normalize` package handles:

```text
email       hashEmailLower      (lowercase + trim + sha256 hex)
phone       hashPhoneE164       (E.164 normalize + sha256 hex)
externalId  canonicalizeExternalId + sha256Hex (consumer applies this)
timestamp   isoToEpochMs        (returned alongside ISO string)
hashing     sha256Hex           (used for anonymous_id)
currency    minorToMajor        (consumer applies this)
```

Meta-specific rules (in `src/mapper.ts`):

- **`action_source` inference** — `app` when any `context.app_*` slot is populated (G7ZCYLL6 / WH7LZ0WZ); `website` when `context.page_url` is populated; otherwise `system_generated`. `app` wins over `website` because a native-app webview may report both and Meta's attribution model expects `app` in that case.
- **`data_processing_options=["LDU"]`** — stamped when `consent.dimensions[?dimension=='marketing'].granted === false`. The normalize layer drops the event entirely if `marketing` is a required-and-denied dimension, so the LDU branch only fires when a destination is more permissive than the mapper (`required_consent.marketing` is true at this consumer, so the LDU branch never actually fires through the runtime — kept as defense-in-depth).

## Vendor dedupe

- **Vendor dedupe field:** Meta `event_id` (top-level on each `data[]` entry).
- **Polaris source field:** canonical `event_id` (UUIDv7).
- **Stability across retries:** confirmed — the destination runtime preserves the delivery key across retry attempts; the canonical `event_id` is the same envelope identifier across retries; the mapper is pure so the same envelope always produces the same wire `event_id`.

Cross-channel dedupe works because Meta accepts the same `event_id` from both the browser pixel and server CAPI; running Polaris alongside Facebook's pixel lets Meta deduplicate matching attempts on Meta's side.

## Consent slot mapping

| Canonical | Vendor field | Default when canonical absent |
|---|---|---|
| `consent.marketing` | implicit (event simply doesn't deliver if denied) | `true` (absent-as-true) |
| `consent.analytics` | `event.consent.dimensions[?...].granted` via downstream debugging | `true` (informational only at receiver) |
| `consent.personalization` | not consumed by Meta CAPI | n/a |

The manifest declares `required_consent.marketing = true`. The normalize layer drops events with `consent.dimensions[marketing].granted === false`, so denied-marketing events become `dropped_consent` delivery records before the mapper sees them.

## Error class table

| Vendor signal | Classification | `error_class` | Behavior |
|---|---|---|---|
| HTTP 2xx | `accepted` | n/a | write `delivery_records` row with status `accepted`; `events_received` + `fbtrace_id` surfaced in `vendor_response_summary` |
| HTTP 408 | `failed_retryable` | `timeout` | re-throw → KafkaJS retries; DLQ at `dead_letter_threshold` |
| HTTP 429 | `failed_retryable` | `rate_limit` | re-throw → KafkaJS retries; per-instance `max_rps` typically prevents this |
| HTTP 5xx | `failed_retryable` | `transient` | re-throw → KafkaJS retries |
| HTTP 401 / 403 | `failed_permanent` | `auth` | DLQ immediately; operator rotates `access_token` via the secret-provider runbook |
| Other 4xx | `failed_permanent` | `permanent` | DLQ immediately; usually a contract violation Meta-side (mapper bug or vendor schema change) |
| Network error | `failed_retryable` | `transient` | re-throw |
| Request timeout (AbortError) | `failed_retryable` | `timeout` | re-throw |
| Malformed secret JSON | `failed_permanent` | `auth` | DLQ immediately |

Access token is redacted from every `vendor_response_summary` before it lands in `delivery_records` / `dlq_records` (see `redactToken` in `src/deliverer.ts`).

## Rate limit profile

- **Vendor-published limit:** Meta documents a CAPI rate limit of ~1000 events/sec per ad account, with bursts allowed. See Meta's Conversions API documentation for the current limit at the time of operator review.
- **Consumer defaults (from `consumer.manifest.yaml`):**
  - `request_timeout_ms`: `5000`
  - `retry_backoff_base_ms`: `250`
  - `retry_backoff_max_seconds`: `300`
  - `max_attempts`: `8`
- **Service knobs (env vars):**
  - `POLARIS_META_CAPI_CONSUMER_GROUP` — default `polaris-meta-capi-v1`
  - `POLARIS_META_CAPI_CONCURRENCY` — default `4`
  - `POLARIS_META_CAPI_REQUEST_TIMEOUT_MS` — default `5000`
  - `POLARIS_META_CAPI_ALLOW_REPLAY` — default `false`
  - `POLARIS_META_CAPI_GRAPH_HOST` — default `graph.facebook.com`
- **Per-instance knobs (PostgreSQL `destinations` row):** `max_concurrency`, `max_rps`, `retry_policy`, `dead_letter_threshold` — tune per ad account.

## Identity field mapping detail

The shared normalize layer prepares Meta-required identity fields:

```text
identity.email_sha256   sha256(lowercased(trimmed(envelope.identity.email)))
identity.phone_sha256   sha256(E.164(envelope.identity.phone))
```

The mapper hashes additional Meta slots:

```text
user_data.external_id   sha256(lowercased(trimmed(identity.customer_id)))
user_data.anon_id       sha256(identity.anonymous_id)   // no canonicalization needed
```

`fn` / `ln` (hashed first/last name) are NOT mapped in v1. The canonical envelope doesn't carry a first/last name slot; a future minor version may add a hook on `identityFromProperties` once a producer ships name data.

`fbp` / `fbc` (browser tracking cookies) are NOT mapped in v1. They live in `properties` if the SDK passes them through, and a future minor version may add a hook to flatten them into `user_data.fbp` / `user_data.fbc`.

## Test fixtures

```text
sync/destinations/meta-capi/v1/test/fixtures/normalized.ts                    builders
sync/destinations/meta-capi/v1/test/fixtures/checkout-started.input.json      canonical event
sync/destinations/meta-capi/v1/test/fixtures/checkout-started.output.json     Meta payload (illustrative shape)
```

The `.input.json` / `.output.json` pair documents the wire shape for the `checkout.started` mapping. Hash values in `.output.json` are placeholders illustrating field positions; the unit tests compute hashes against `sha256Hex(...)` and assert against the computed result so the goldens stay readable without becoming brittle.

The vendor delivery step (network) is exercised against a `fetch` stub in `test/deliverer.test.ts` and `test/integration.test.ts`. An end-to-end test against Meta's sandbox (`test_event_code`) is documented operationally but not run by CI — it requires live Meta credentials.

## Known divergences from canonical

- **Meta requires sha256-lowercased-trimmed email/phone** — canonical events MAY pass raw email and the shared normalize layer hashes them. The Meta consumer never sees raw email/phone; only the `*_sha256` slots are read.
- **Meta requires `event_time` as Unix seconds** — canonical envelopes carry `occurred_at` as ISO 8601 + `occurred_at_epoch_ms` (milliseconds). The mapper floors `epoch_ms / 1000` to get seconds.
- **Meta's `value` is decimal** — canonical envelopes carry currency amounts in minor units (per `01-event-contract.md`). The mapper applies `minorToMajor(amount, currency)` with the ISO 4217 exponent. Zero-decimal currencies (JPY, KRW) pass through unchanged.
- **Mobile-app sources are detected via `context.app_*`** (G7ZCYLL6): when any of `app_bundle_id` / `app_version` / `app_namespace` / `app_build` / `app_idfa` / `app_idfv` / `app_gaid` is populated on the flat context, the mapper stamps `action_source: "app"`. Backend-emitted events with no `app_*` and no `page_url` continue to land as `system_generated`. SDKs running inside a native webview SHOULD set at least `app_bundle_id` so Meta's attribution model treats the event as mobile rather than web.

## Vendor API changelog

```text
Vendor release notes URL:                  https://developers.facebook.com/docs/graph-api/changelog/
Vendor API version this consumer targets:  v22.0
Last vendor-side compatibility check:      2026-05-14
```

When Meta breaks compatibility (typical cadence: ~quarterly), a new consumer version (`v2`) is required. v1 stays as the migration reference; operators flip per-instance `consumer_version` via `polaris destinations update-ops` after draining v1 offsets per `docs/architecture/06-destinations.md` "Version coexistence and migration".

## Migration notes

n/a — v1 is the initial release.

## The resolved.events flip (MVKUP64R)

Meta CAPI reads `resolved.events`. One delta.

**`external_id` prefers `profile.canonical_customer_id`**, falling back to the producer's `user_id` exactly as before when nothing was resolved. Hashing is unchanged — lowercased, trimmed, sha256 — so the value stays comparable to ids Meta already holds.

`external_id` is Meta's cross-session join key, so it should carry the most durable id Polaris has. `user_id` is what one event's producer happened to send; `canonical_customer_id` is the identity stage's conclusion after reconciling every identifier ever seen for the person. Two producers spelling the same customer differently used to land as two Meta users and now converge.

Dedupe keys are untouched. `em`, `ph` and `anon_id` are untouched.
