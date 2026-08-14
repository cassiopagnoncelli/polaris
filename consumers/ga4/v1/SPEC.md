# Consumer SPEC: `ga4` v1

> Third real-vendor consumer of the destination runtime, following the structural template set by `consumers/meta-capi/v1/` (P9-003) and `consumers/tiktok/v1/` (P9-005). Maps the canonical Polaris commerce event subset (`checkout.started`, `payment.approved`, `user.identified`) into the GA4 Measurement Protocol payload shape, passes the canonical `customer_id` / `anonymous_id` as raw `user_id` / `client_id` (GA4 does not consume hashed identifiers), and POSTs to `https://www.google-analytics.com/mp/collect?measurement_id=<id>&api_secret=<secret>`.

## Vendor

- **Name:** Google Analytics 4 — Measurement Protocol
- **API version this consumer targets:** `mp` (the Measurement Protocol endpoint has no numeric API version — Google evolves the contract in place; pinned conceptually in `consumer.manifest.yaml` as `vendor_api_version: mp`)
- **Documentation:** [GA4 Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4)
- **Auth scheme:** Property-scoped `api_secret` (issued in the GA4 Admin UI, stored in `destinations.secret_value` and replaced with `polaris destinations rotate-secret`) passed as a URL query-string parameter alongside the property's `measurement_id` (web stream) or `firebase_app_id` (app stream, KCS3ATPC). GA4 has no header-based auth option for the Measurement Protocol.
- **Base URL(s):** `https://www.google-analytics.com/mp/collect`. The host is overridable per deployment via `POLARIS_GA4_API_HOST`, and per project via `polaris config set --namespace ga4 --key api_host` (which wins); production is the canonical literal. A debug variant `/debug/mp/collect` on the same host returns verbose validation responses — v1 does not target the debug endpoint at runtime; operators can flip the path manually during triage. The query string carries `measurement_id=<id>` for web-stream events and `firebase_app_id=<id>` for app-stream events (the deliverer chooses based on the resolved secret + the mapper's `app_instance_id` hint).

## Supported canonical events

```text
checkout.started       →  begin_checkout
payment.approved       →  purchase
user.identified        →  login (method='polaris')
signup.completed       →  sign_up (method='polaris')
subscription.renewed   →  subscription_renewed (custom event)
```

GA4 has no recommended event for recurring billing, so v1 emits a snake_case custom event (`subscription_renewed`) for `subscription.renewed`. Per GA4's documented dedupe contract, only `purchase` dedupes cross-channel via `transaction_id`; `subscription_renewed` carries `transaction_id` for triage parity but GA4 will not dedupe it. Events outside this set produce `mapped_failed` delivery records with `error_class='mapping'`. The runbook (`docs/operations/destination-dlq-triage.md`) covers the operator path; future minor versions will extend the matrix. Notable not-yet-supported events:

```text
support.ticket.opened  GA4 has no canonical equivalent; never delivered
polaris.diagnostics.*  internal-only platform telemetry; never delivered
```

## Field mapping

### `checkout.started` → `begin_checkout`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `identity.anonymous_id` | request `client_id` | none | wrapper-level; required by GA4. Falls back to `delivery_key` when canonical `anonymous_id` is absent so retries stay stable. |
| `identity.customer_id` | request `user_id` | none | wrapper-level; optional. GA4 stitches `user_id` to `client_id` when both are present. |
| `occurred_at_epoch_ms` | request `timestamp_micros` | `epoch_ms * 1000` | GA4 accepts events up to ~72h in the past via `timestamp_micros`. |
| inferred | `event.name` | branch on canonical event | `checkout.started` → `begin_checkout` |
| `properties.total` | `event.params.value` | `minorToMajor(value, currency)` | GA4 wants decimal; minor → major per ISO 4217 exponent |
| `properties.currency` | `event.params.currency` | none | ISO 4217 alphabetic |
| `properties.items[]` | `event.params.items[]` | per-item builder | sku → `item_id`; name → `item_name`; quantity → `quantity`; `unit_price` → `price` (minor → major) |
| `context.app_idfv` (fallback `context.app_gaid`) | request `app_instance_id` | first-non-null wins | wrapper-level; populated only when the canonical envelope reports an app source AND the secret carries `firebase_app_id`. Replaces `client_id` in that case (KCS3ATPC) |

### `payment.approved` → `purchase`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `identity.anonymous_id` | request `client_id` | none | wrapper-level; required by GA4 on web-stream requests |
| `identity.customer_id` | request `user_id` | none | wrapper-level; optional |
| `context.app_idfv` (fallback `context.app_gaid`) | request `app_instance_id` | first-non-null wins | wrapper-level; Firebase / app-stream alternative to `client_id` (KCS3ATPC) |
| `occurred_at_epoch_ms` | request `timestamp_micros` | `epoch_ms * 1000` | optional; absent → GA4 stamps receive-time |
| inferred | `event.name` | branch on canonical event | `payment.approved` → `purchase` |
| `properties.amount_minor` (or `amount`) | `event.params.value` | `minorToMajor` | Falls back to `amount` for legacy producers |
| `properties.currency` | `event.params.currency` | none | ISO 4217 |
| `properties.transaction_id` (or `order_id`) | `event.params.transaction_id` | none | **Vendor dedupe slot.** First-non-null wins. Also surfaced as `delivery_records.dedupe_key` |
| `properties.items[]` | `event.params.items[]` | per-item builder | same as begin_checkout |

### `user.identified` → `login`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `identity.anonymous_id` | request `client_id` | none | wrapper-level |
| `identity.customer_id` | request `user_id` | none | wrapper-level; this event is the one that establishes the `client_id` ↔ `user_id` join inside GA4 |
| `occurred_at_epoch_ms` | request `timestamp_micros` | `epoch_ms * 1000` | optional |
| inferred | `event.name` | constant | `login` |
| constant | `event.params.method` | constant | `polaris` (labels the auth provider so GA4 reports can split Polaris logins out from organic gtag logins) |

No additional event-specific properties are populated — `login` is a lightweight identity-emission signal.

### `signup.completed` → `sign_up`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `identity.anonymous_id` | request `client_id` | none | wrapper-level |
| `identity.customer_id` | request `user_id` | none | wrapper-level; pairs with `client_id` so GA4 stitches the new account |
| `occurred_at_epoch_ms` | request `timestamp_micros` | `epoch_ms * 1000` | optional |
| inferred | `event.name` | constant | `sign_up` |
| constant | `event.params.method` | constant | `polaris` (labels the auth provider so GA4 reports can split Polaris signups out from organic gtag signups) |

No additional event-specific properties are populated — `sign_up` is a lightweight identity-emission signal that mirrors `login` on the vendor side. GA4 has no documented cross-event dedupe for `sign_up`, so the Polaris-side `dedupe_key` falls through to the canonical `event_id`.

### `subscription.renewed` → `subscription_renewed` (custom event)

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `identity.anonymous_id` | request `client_id` | none | wrapper-level |
| `identity.customer_id` | request `user_id` | none | wrapper-level |
| `occurred_at_epoch_ms` | request `timestamp_micros` | `epoch_ms * 1000` | optional |
| inferred | `event.name` | constant | `subscription_renewed` (snake_case per GA4's custom-event naming convention) |
| `properties.amount_minor` (or `amount`) | `event.params.value` | `minorToMajor` | Falls back to `amount` for legacy producers |
| `properties.currency` | `event.params.currency` | none | ISO 4217 |
| `properties.subscription_id` | `event.params.transaction_id` | none | Stable per-cycle id on the renewal. Mirrors the `purchase` slot so triage queries against duplicates have a stable handle; GA4 does NOT dedupe custom events. |

GA4 has no recommended event for recurring billing — v1 emits a snake_case custom event. The Polaris-side `dedupe_key` falls through to the canonical `event_id`; GA4 will not cross-channel dedupe this event.

## Normalization rules

The shared `@polaris/shared-destination-normalize` package handles:

```text
timestamp   isoToEpochMs        (returned alongside ISO string)
currency    minorToMajor        (consumer applies this)
```

GA4 does NOT require hashed identifiers — the consumer's `identityHashing` flags are off (`email: false`, `phone: false`). The shared normalize layer skips email / phone hashing for this consumer, which keeps CPU usage proportional to the actual fields the mapper emits.

GA4-specific rules (in `src/mapper.ts`):

- **`client_id` synthesis (web-stream)** — GA4 requires `client_id` on every web-stream request. The deliverer prefers the canonical `anonymous_id` (matches the gtag client id shape) but falls back to `delivery_key` so the same envelope produces a stable `client_id` across retries. In a future minor version, `anonymous_id` will become the source of truth once the normalized envelope's identity surfaces to the deliverer alongside the mapped payload.
- **`app_instance_id` synthesis (Firebase / app-stream, KCS3ATPC)** — when the canonical envelope reports an app source (any `context.app_*` slot populated) the mapper synthesizes `app_instance_id` from `context.app_idfv` (preferred — iOS Vendor Identifier, UUID format) falling back to `context.app_gaid` (Android Advertising Id). The synthesized value rides on the per-event payload's `app_instance_id` slot (Polaris-internal hint) and the deliverer lifts it to the request wrapper, stripping it from the wire event payload. App-stream routing only activates when the credential also carries `firebase_app_id`; operators who haven't rotated stay on the web-stream wrapper. Rotating is [GA4 Firebase app-stream rotation](../../../docs/operations/ga4-firebase-app-stream-rotation.md) — note that GA4 answers `204` for a stream it is not configured to receive, so the runbook's verification step is what distinguishes success from silently lost events.
- **`timestamp_micros` derivation** — when populated, derived from `occurred_at_epoch_ms * 1000`. GA4 accepts up to ~72h in the past. If omitted, GA4 stamps the receive-time.
- **`params.items[]` builder** — GA4's preferred per-product detail slot. The mapper emits one entry per canonical `properties.items[]` with `item_id` (sku), `item_name`, `quantity`, and `price` (unit_price minor → major). Entries with no usable fields are dropped from the array; an empty array is omitted entirely.

## Vendor dedupe

- **Vendor dedupe field:** GA4 `transaction_id` (inside `params` on `purchase` events). GA4 does not document a cross-event dedupe slot for non-purchase events.
- **Polaris source field:**
  - `purchase`: canonical `properties.transaction_id` (preferred) or `properties.order_id` (fallback). The same value lands on both the vendor `params.transaction_id` slot and the Polaris-side `delivery_records.dedupe_key` so the two stay aligned.
  - `begin_checkout` / `login` / `sign_up` / `subscription_renewed`: canonical `event_id` for the Polaris-side dedupe key only. GA4 does not dedupe these. `subscription_renewed` carries the `subscription_id` on `params.transaction_id` for operator-side parity with `purchase`, but it is a custom event and GA4 has no cross-event dedupe contract for custom events.
- **Stability across retries:** confirmed — the destination runtime preserves the delivery key across retry attempts; the canonical `transaction_id` is stable per purchase, and the mapper is pure so the same envelope always produces the same wire `transaction_id`.

Cross-channel dedupe works for `purchase` because GA4 deduplicates against the same `transaction_id` whether it arrives via the gtag (browser) or the Measurement Protocol (server). Running Polaris alongside the GA4 web SDK lets GA4 dedupe matching attempts on GA4's side as long as both pipelines stamp the same `transaction_id`.

**v1 does NOT promise universal GA4 event dedupe.** Only `purchase` has documented vendor dedupe; `begin_checkout`, `login`, `sign_up`, and `subscription_renewed` may surface as duplicates on the GA4 side if a retry storm and the gtag race the Measurement Protocol — there is no GA4-side mechanism to prevent this. Operators triage duplicates via the Polaris-side `dedupe_key` instead.

## Consent slot mapping

| Canonical | Vendor field | Default when canonical absent |
|---|---|---|
| `consent.analytics` | implicit (event simply doesn't deliver if denied) | `true` (absent-as-true) |
| `consent.marketing` | not consumed by GA4 Measurement Protocol | n/a |
| `consent.personalization` | not consumed by GA4 Measurement Protocol | n/a |

The manifest declares `required_consent.analytics = true`. The normalize layer drops events with `consent.dimensions[analytics].granted === false`, so denied-analytics events become `dropped_consent` delivery records before the mapper sees them.

GA4 Consent Mode v2 (`ad_user_data`, `ad_personalization`) is NOT modeled in v1. Those flags are gtag-level signals that ride alongside the page-side SDK; the Measurement Protocol has no equivalent slot. A future minor version may surface `marketing` and `personalization` as wire-level consent flags once Google publishes the Measurement Protocol contract for them.

## Error class table

| Vendor signal | Classification | `error_class` | Behavior |
|---|---|---|---|
| HTTP 204 No Content | `accepted` | n/a | the canonical GA4 success response; `delivery_records.vendor_response_summary` records "204 No Content" |
| HTTP 200 (debug endpoint) | `accepted` | n/a | the `/debug/mp/collect` variant returns 200 with a validation JSON body; treated as accepted |
| HTTP 408 | `failed_retryable` | `timeout` | re-throw → KafkaJS retries; DLQ at `dead_letter_threshold` |
| HTTP 429 | `failed_retryable` | `rate_limit` | re-throw → KafkaJS retries; per-instance `max_rps` typically prevents this |
| HTTP 5xx | `failed_retryable` | `transient` | re-throw → KafkaJS retries |
| HTTP 401 / 403 | `failed_permanent` | `auth` | DLQ immediately; operator rotates `api_secret` via the GA4 Admin UI |
| Other 4xx | `failed_permanent` | `permanent` | DLQ immediately; usually a contract violation GA4-side (mapper bug or Measurement Protocol schema change) |
| Network error | `failed_retryable` | `transient` | re-throw |
| Request timeout (AbortError) | `failed_retryable` | `timeout` | re-throw |
| Malformed secret JSON | `failed_permanent` | `auth` | DLQ immediately |

Note: GA4's Measurement Protocol does NOT return application-level error codes on the production endpoint — every successful POST returns HTTP 204 No Content with an empty body, even for events the receiver chooses to drop (e.g. unknown `client_id` patterns). Triage of "GA4 says success but the property has no data" lives on the GA4 side; the `/debug/mp/collect` variant surfaces validation errors that v1 does not yet auto-parse. The `api_secret` is redacted from every `vendor_response_summary` before it lands in `delivery_records` / `dlq_records` (see `redactToken` in `src/deliverer.ts`).

## Rate limit profile

- **Vendor-published limit:** Google documents the Measurement Protocol limit as up to 200,000 hits per property per day with bursts of up to 60 events per request. See [Google's Measurement Protocol limits documentation](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events?client_type=gtag#limitations) for the current limit at the time of operator review.
- **Consumer defaults (from `consumer.manifest.yaml`):**
  - `request_timeout_ms`: `5000`
  - `retry_backoff_base_ms`: `250`
  - `retry_backoff_max_seconds`: `300`
  - `max_attempts`: `8`
- **Service knobs (env vars):**
  - `POLARIS_GA4_CONSUMER_GROUP` — default `polaris-ga4-v1`
  - `POLARIS_GA4_CONCURRENCY` — default `4`
  - `POLARIS_GA4_REQUEST_TIMEOUT_MS` — default `5000`
  - `POLARIS_GA4_ALLOW_REPLAY` — default `false`
  - `POLARIS_GA4_API_HOST` — default `www.google-analytics.com`
- **Per-instance knobs (PostgreSQL `destinations` row):** `max_concurrency`, `max_rps`, `retry_policy`, `dead_letter_threshold` — tune per measurement-id.

## Identity field mapping detail

GA4 Measurement Protocol consumes `client_id` and `user_id` as raw opaque strings. There is no hashed-identifier slot — Google explicitly forbids PII (e.g. email addresses) in either field per the [Measurement Protocol PII policy](https://developers.google.com/analytics/devguides/collection/protocol/ga4/policy).

```text
request.client_id   identity.anonymous_id  (preferred; gtag-compatible shape)
                    delivery_key           (fallback when anonymous_id is null — keeps retries stable)
request.user_id     identity.customer_id   (optional; establishes the cross-device join inside GA4)
```

The canonical `email_sha256` / `phone_sha256` slots are NOT mapped — GA4 has no Measurement Protocol slot for them. Email matching on the GA4 side happens through the `user_id` join (when both the source-of-truth system and GA4 share the same `customer_id`).

`first_name` / `last_name` are NOT mapped — GA4 has no slot for them outside enhanced-conversions (a separate ads-side product not covered by the Measurement Protocol).

## Test fixtures

```text
consumers/ga4/v1/test/fixtures/normalized.ts                    builders
consumers/ga4/v1/test/fixtures/checkout-started.input.json      canonical web-stream event
consumers/ga4/v1/test/fixtures/checkout-started.output.json     GA4 web-stream payload (illustrative shape)
consumers/ga4/v1/test/fixtures/app-source-purchase.input.json   canonical app-source event (KCS3ATPC)
consumers/ga4/v1/test/fixtures/app-source-purchase.output.json  GA4 Firebase app-stream payload
```

The `.input.json` / `.output.json` pair documents the wire shape for the `checkout.started` mapping. Tests cover the `payment.approved` → `purchase` purchase-dedupe behaviour (transaction_id preferred over order_id; fallback to event_id when both are absent) directly inside `test/mapper.test.ts` against the in-memory fixture builders so the goldens stay readable without becoming brittle.

The vendor delivery step (network) is exercised against a `fetch` stub in `test/deliverer.test.ts` and `test/integration.test.ts`. An end-to-end test against GA4's `/debug/mp/collect` endpoint is documented operationally but not run by CI — it requires live GA4 credentials.

## Known divergences from canonical

- **GA4 splits web and Firebase data streams at the Measurement Protocol URL level** (KCS3ATPC): web-stream events use `?measurement_id=<id>&api_secret=<secret>` with `client_id` on the wrapper; Firebase / app-stream events use `?firebase_app_id=<id>&api_secret=<secret>` with `app_instance_id` on the wrapper. The deliverer routes based on (a) whether the mapper produced an `app_instance_id` from `context.app_*` slots AND (b) whether the resolved secret carries `firebase_app_id`. Operators who haven't rotated their secret to add `firebase_app_id` continue to flow app-source events through the web-stream URL (Polaris won't half-route).
- **GA4 does NOT require hashed identifiers** — canonical events MAY pass raw email and phone, but GA4 consumes only `client_id` / `user_id`. The `identityHashing` flags are off so the normalize layer skips the email / phone hashing pass for this consumer. Email matching on the GA4 side happens through the `user_id` join.
- **GA4 returns HTTP 204 No Content on success** — unlike TikTok / Meta CAPI which return a small JSON document with a `request_id`. The deliverer treats every 2xx (including 204) as `accepted` and surfaces "204 No Content" as the `vendor_response_summary`.
- **GA4 places the credential in the URL query string** — unlike TikTok (Access-Token header) and Meta CAPI (Authorization Bearer). The deliverer redacts the `api_secret` from every `vendor_response_summary` before it lands in PostgreSQL, in case Google's error pages echo request URLs.
- **GA4's `value` is decimal** — canonical envelopes carry currency amounts in minor units (per `01-event-contract.md`). The mapper applies `minorToMajor(amount, currency)` with the ISO 4217 exponent. Zero-decimal currencies (JPY, KRW) pass through unchanged.
- **GA4 has no documented cross-event dedupe outside `purchase`** — only the `purchase` event's `transaction_id` is a Google-promised dedupe slot. `begin_checkout` and `login` MAY produce duplicate rows on the GA4 side if a retry storm races the gtag; operators triage via the Polaris-side `dedupe_key` instead. v1 does NOT promise universal dedupe.
- **GA4 has no numeric API version** — Google evolves the Measurement Protocol in place. When Google breaks compatibility, the operator path is the same as for vendors with a numeric version (cut a v2 of the consumer); the difference is that the manifest `vendor_api_version` slot carries the conceptual contract name (`mp`) rather than a Google-supplied version literal.

## Vendor API changelog

```text
Vendor release notes URL:                  https://developers.google.com/analytics/devguides/collection/protocol/ga4
Vendor API version this consumer targets:  mp (no numeric version)
Last vendor-side compatibility check:      2026-05-14
```

When Google breaks compatibility on the Measurement Protocol (historically Google ships small backwards-compatible additions; a major break would warrant a press release), a new consumer version (`v2`) is required. v1 stays as the migration reference; operators flip per-instance `consumer_version` via `polaris destinations update-ops` after draining v1 offsets per `docs/architecture/06-destinations.md` "Version coexistence and migration".

## Migration notes

n/a — v1 is the initial release.
