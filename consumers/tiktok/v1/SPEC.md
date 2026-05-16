# Consumer SPEC: `tiktok` v1

> Second real-vendor consumer of the destination runtime, following the structural template set by `consumers/meta-capi/v1/` (P9-003). Maps the canonical Polaris commerce event subset (`checkout.started`, `payment.approved`, `user.identified`) into TikTok's Events API payload shape, hashes identifiers per TikTok's requirements (which mirror Meta's), and POSTs to `business-api.tiktok.com/open_api/<api_version>/event/track/`.

## Vendor

- **Name:** TikTok Events API (part of the TikTok Marketing API)
- **API version this consumer targets:** `v1.3` (pinned in `src/descriptor-identity.ts` as `TIKTOK_EVENTS_API_VERSION`)
- **Documentation:** [TikTok Events API](https://business-api.tiktok.com/portal/docs?id=1771101303285761) at the targeted version
- **Auth scheme:** Long-lived access token passed as `Access-Token: <token>` request header (TikTok's documented contract; no Authorization-Bearer, no URL query parameter).
- **Base URL(s):** `https://business-api.tiktok.com/open_api/<api_version>/event/track/`. The host is overridable via `POLARIS_TIKTOK_API_HOST` for staging endpoints; production is the canonical literal. The trailing slash on `/event/track/` is required by TikTok's router.

## Supported canonical events

```text
checkout.started       →  InitiateCheckout
payment.approved       →  Purchase
user.identified        →  CompleteRegistration
signup.completed       →  CompleteRegistration
subscription.renewed   →  Subscribe
```

Both `user.identified` and `signup.completed` map to TikTok's
`CompleteRegistration` because TikTok does not expose a `Lead` event;
the canonical `event_id` keeps the two streams distinct on the
receive side. Events outside this set produce `mapped_failed`
delivery records with `error_class='mapping'`. The runbook
(`docs/operations/destination-dlq-triage.md`) covers the operator
path; future minor versions will extend the matrix. Notable
not-yet-supported events:

```text
support.ticket.opened  TikTok has no canonical equivalent; never delivered
polaris.diagnostics.*  internal-only platform telemetry; never delivered
```

## Field mapping

### `checkout.started` → `InitiateCheckout`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | Vendor dedupe key; matches browser-pixel `event_id` for cross-channel dedupe |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | TikTok requires Unix seconds, not ms; floor(ms/1000) |
| `context.page.url` | `page.url` | none | When present; absent → omitted |
| inferred | wrapper `event_source` | branch on app/page context | `app` when any `context.app_*` slot is populated; `web` when `context.page.url` is populated; otherwise `crm` |
| `identity.customer_id` | `user.external_id` | `sha256(lowercased(trim(value)))` | TikTok requires hash for external_id |
| `identity.email_sha256` | `user.email` | (already hashed by normalize) | shared-destination-normalize handles email sha256 |
| `identity.phone_sha256` | `user.phone` | (already hashed by normalize) | E.164 + sha256 |
| `context.ip` | `user.ip` | passthrough | TikTok uses for ad-attribution match |
| `context.user_agent` | `user.user_agent` | passthrough | same |
| `context.locale` | `user.locale` | passthrough | optional, improves match quality |
| `properties.cart_id` | `properties.order_id` | none | TikTok accepts arbitrary order_id |
| `properties.total` | `properties.value` | `minorToMajor(value, currency)` | TikTok wants decimal; minor → major per ISO 4217 exponent |
| `properties.currency` | `properties.currency` | none | ISO 4217 alphabetic |
| `properties.items[].quantity` (sum) | `properties.num_items` | sum + integer-check | When present |
| `properties.items[]` | `properties.contents[]` | per-item builder | sku → `content_id`; quantity → `quantity`; `unit_price` → `price` (minor → major) |

### `payment.approved` → `Purchase`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | dedupe key |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | seconds |
| `identity.*` | `user.*` | same as checkout | see above |
| `context.*` | `user.*` + `page.url` | same as checkout | see above |
| `properties.amount_minor` (or `amount`) | `properties.value` | `minorToMajor` | Falls back to `amount` for legacy producers |
| `properties.currency` | `properties.currency` | none | ISO 4217 |
| `properties.order_id` (or `transaction_id`) | `properties.order_id` | none | First-non-null wins |

### `user.identified` → `CompleteRegistration`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | dedupe key |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | seconds |
| `identity.*` | `user.*` | same as checkout | see above |
| `context.*` | `user.*` + `page.url` | same as checkout | see above |

No `properties` block is populated — `CompleteRegistration` is a lightweight signup signal.

### `signup.completed` → `CompleteRegistration`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | dedupe key |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | seconds |
| `identity.*` | `user.*` | same as checkout | see above |
| `context.*` | `user.*` + `page.url` | same as checkout | see above |
| `properties.currency` | `properties.currency` | none | Optional; forwarded when supplied so TikTok can bucket by paid-acquisition channel |

### `subscription.renewed` → `Subscribe`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `event_id` | `event_id` | none | dedupe key |
| `occurred_at` | `event_time` | `isoToEpochSeconds` | seconds |
| `identity.*` | `user.*` | same as checkout | see above |
| `context.*` | `user.*` + `page.url` | same as checkout | see above |
| `properties.amount_minor` (or `amount`) | `properties.value` | `minorToMajor` | Falls back to `amount` for legacy producers |
| `properties.currency` | `properties.currency` | none | ISO 4217 |
| `properties.subscription_id` | `properties.order_id` | none | Stable per-cycle id on the renewal |

## Normalization rules

The shared `@polaris/shared-destination-normalize` package handles:

```text
email       hashEmailLower      (lowercase + trim + sha256 hex)
phone       hashPhoneE164       (E.164 normalize + sha256 hex)
externalId  canonicalizeExternalId + sha256Hex (consumer applies this)
timestamp   isoToEpochMs        (returned alongside ISO string)
hashing     sha256Hex           (used wherever the mapper hashes outside the helpers)
currency    minorToMajor        (consumer applies this)
```

TikTok-specific rules (in `src/mapper.ts`):

- **`event_source` inference** — `app` when any `context.app_*` slot is populated (WH7LZ0WZ); `web` when `context.page_url` is populated; otherwise `crm` (TikTok's backend-event default). `app` wins over `web` so native-app webviews land correctly. TikTok stamps `event_source` on the wire wrapper, not the per-event payload; the deliverer reads the inferred value from the payload's source-context slots.
- **`limited_data_use = 1`** — stamped when `consent.dimensions[?dimension=='marketing'].granted === false`. The normalize layer drops the event entirely if `marketing` is a required-and-denied dimension, so the `limited_data_use` branch only fires when a destination is more permissive than the mapper (`required_consent.marketing` is true at this consumer, so the LDU branch never actually fires through the runtime — kept as defense-in-depth).
- **`properties.contents[]` builder** — TikTok's preferred per-product detail slot. The mapper emits one entry per canonical `properties.items[]` with `content_id` (sku), `quantity`, and `price` (unit_price minor → major). Entries with no usable fields are dropped from the array; an empty array is omitted entirely.

## Vendor dedupe

- **Vendor dedupe field:** TikTok `event_id` (top-level on each `data[]` entry).
- **Polaris source field:** canonical `event_id` (UUIDv7).
- **Stability across retries:** confirmed — the destination runtime preserves the delivery key across retry attempts; the canonical `event_id` is the same envelope identifier across retries; the mapper is pure so the same envelope always produces the same wire `event_id`.

Cross-channel dedupe works because TikTok accepts the same `event_id` from both the browser pixel and the server Events API; running Polaris alongside TikTok's pixel lets TikTok deduplicate matching attempts on TikTok's side.

## Consent slot mapping

| Canonical | Vendor field | Default when canonical absent |
|---|---|---|
| `consent.marketing` | implicit (event simply doesn't deliver if denied); `limited_data_use=1` when permissive | `true` (absent-as-true) |
| `consent.analytics` | not consumed by TikTok Events API | n/a |
| `consent.personalization` | not consumed by TikTok Events API | n/a |

The manifest declares `required_consent.marketing = true`. The normalize layer drops events with `consent.dimensions[marketing].granted === false`, so denied-marketing events become `dropped_consent` delivery records before the mapper sees them.

## Error class table

| Vendor signal | Classification | `error_class` | Behavior |
|---|---|---|---|
| HTTP 2xx | `accepted` | n/a | write `delivery_records` row with status `accepted`; `request_id` surfaced in `vendor_response_summary` |
| HTTP 408 | `failed_retryable` | `timeout` | re-throw → KafkaJS retries; DLQ at `dead_letter_threshold` |
| HTTP 429 | `failed_retryable` | `rate_limit` | re-throw → KafkaJS retries; per-instance `max_rps` typically prevents this |
| HTTP 5xx | `failed_retryable` | `transient` | re-throw → KafkaJS retries |
| HTTP 401 / 403 | `failed_permanent` | `auth` | DLQ immediately; operator rotates `access_token` via the secret-provider runbook |
| Other 4xx | `failed_permanent` | `permanent` | DLQ immediately; usually a contract violation TikTok-side (mapper bug or vendor schema change) |
| Network error | `failed_retryable` | `transient` | re-throw |
| Request timeout (AbortError) | `failed_retryable` | `timeout` | re-throw |
| Malformed secret JSON | `failed_permanent` | `auth` | DLQ immediately |

Note: TikTok's Events API uses HTTP 200 even for some application-level errors (the body carries `code != 0` to signal failure). v1 only inspects the HTTP status code; a future minor version may parse `code` from the response body to classify business-level errors more aggressively. Access token is redacted from every `vendor_response_summary` before it lands in `delivery_records` / `dlq_records` (see `redactToken` in `src/deliverer.ts`).

## Rate limit profile

- **Vendor-published limit:** TikTok documents the Events API limit as up to 100 events per request and ~2000 events/minute/pixel (varies per account tier). See TikTok's Events API documentation for the current limit at the time of operator review.
- **Consumer defaults (from `consumer.manifest.yaml`):**
  - `request_timeout_ms`: `5000`
  - `retry_backoff_base_ms`: `250`
  - `retry_backoff_max_seconds`: `300`
  - `max_attempts`: `8`
- **Service knobs (env vars):**
  - `POLARIS_TIKTOK_CONSUMER_GROUP` — default `polaris-tiktok-v1`
  - `POLARIS_TIKTOK_CONCURRENCY` — default `4`
  - `POLARIS_TIKTOK_REQUEST_TIMEOUT_MS` — default `5000`
  - `POLARIS_TIKTOK_ALLOW_REPLAY` — default `false`
  - `POLARIS_TIKTOK_API_HOST` — default `business-api.tiktok.com`
- **Per-instance knobs (PostgreSQL `destinations` row):** `max_concurrency`, `max_rps`, `retry_policy`, `dead_letter_threshold` — tune per pixel.

## Identity field mapping detail

The shared normalize layer prepares TikTok-required identity fields:

```text
identity.email_sha256   sha256(lowercased(trimmed(envelope.identity.email)))
identity.phone_sha256   sha256(E.164(envelope.identity.phone))
```

The mapper hashes additional TikTok slots:

```text
user.external_id        sha256(lowercased(trimmed(identity.customer_id)))
```

`first_name` / `last_name` (hashed) are NOT mapped in v1. The canonical envelope doesn't carry a first/last name slot; a future minor version may add a hook on `identityFromProperties` once a producer ships name data.

`ttp` / `ttclid` (TikTok tracking cookies) are NOT mapped in v1. They live in `properties` if the SDK passes them through, and a future minor version may add a hook to flatten them into `user.ttp` / `user.ttclid`. TikTok's `ttclid` is functionally analogous to Meta's `fbc`; `ttp` is analogous to `fbp`.

## Test fixtures

```text
consumers/tiktok/v1/test/fixtures/normalized.ts                    builders
consumers/tiktok/v1/test/fixtures/checkout-started.input.json      canonical event
consumers/tiktok/v1/test/fixtures/checkout-started.output.json     TikTok payload (illustrative shape)
```

The `.input.json` / `.output.json` pair documents the wire shape for the `checkout.started` mapping. Hash values in `.output.json` are placeholders illustrating field positions; the unit tests compute hashes against `sha256Hex(...)` and assert against the computed result so the goldens stay readable without becoming brittle.

The vendor delivery step (network) is exercised against a `fetch` stub in `test/deliverer.test.ts` and `test/integration.test.ts`. An end-to-end test against TikTok's Events API debugger (`test_event_code`) is documented operationally but not run by CI — it requires live TikTok credentials.

## Known divergences from canonical

- **TikTok requires sha256-lowercased-trimmed email/phone** — canonical events MAY pass raw email and the shared normalize layer hashes them. The TikTok consumer never sees raw email/phone; only the `*_sha256` slots are read.
- **TikTok requires `event_time` as Unix seconds** — canonical envelopes carry `occurred_at` as ISO 8601 + `occurred_at_epoch_ms` (milliseconds). The mapper floors `epoch_ms / 1000` to get seconds.
- **TikTok's `value` is decimal** — canonical envelopes carry currency amounts in minor units (per `01-event-contract.md`). The mapper applies `minorToMajor(amount, currency)` with the ISO 4217 exponent. Zero-decimal currencies (JPY, KRW) pass through unchanged.
- **TikTok `event_source` is request-level, not per-payload** — Meta CAPI's `action_source` rides on each event; TikTok's `event_source` rides on the wrapper. The deliverer reads the inferred source from the first payload's `page.url` slot to stamp the wrapper; v1 only ships one payload per request, so this is a clean mapping.
- **Mobile-app sources are detected via `context.app_*`** (WH7LZ0WZ): when any of `app_bundle_id` / `app_version` / `app_namespace` / `app_build` / `app_idfa` / `app_idfv` / `app_gaid` is populated on the flat context, the deliverer stamps the wrapper's `event_source` as `app`. Backend-emitted events with no `app_*` and no `page_url` continue to land as `crm`.
- **TikTok returns HTTP 200 even for some application-level errors** — the body carries `code != 0` to signal failure. v1 classifies on HTTP status alone; a future minor version may parse the body to reclassify these as `failed_permanent`.

## Vendor API changelog

```text
Vendor release notes URL:                  https://business-api.tiktok.com/portal/docs?id=1771100752199682
Vendor API version this consumer targets:  v1.3
Last vendor-side compatibility check:      2026-05-14
```

When TikTok breaks compatibility (TikTok historically bumps Events API minor versions roughly every 6–12 months), a new consumer version (`v2`) is required. v1 stays as the migration reference; operators flip per-instance `consumer_version` via `polaris destinations update-ops` after draining v1 offsets per `docs/architecture/06-destinations.md` "Version coexistence and migration".

## Migration notes

n/a — v1 is the initial release.
