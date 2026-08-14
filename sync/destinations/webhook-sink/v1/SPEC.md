# Consumer SPEC: `webhook-sink` v1

> The webhook-sink consumer is the canonical "thin" exemplar of the Polaris destination consumer pipeline. It performs no vendor-specific normalization and registers no per-event mappers; every canonical event is delivered byte-for-byte under `event` inside a stable Polaris delivery envelope. Future vendor consumers (Meta CAPI, GA4, TikTok, Braze) clone the directory shape and replace the passthrough mapper with vendor-specific ones.

## Vendor

- **Name:** Generic webhook receiver (vendor-agnostic).
- **API version this consumer targets:** n/a — receivers vary; the contract is set by Polaris, not a vendor.
- **Documentation:** the receiver-side contract is documented in `docs/architecture/06-destinations.md` "Destination Consumer" and the wire format pinned in `sync/destinations/webhook-sink/v1/src/types.ts` (`WebhookPayload`).
- **Auth scheme:** Optional HMAC-SHA256 body signature over the JSON request body. Header `X-Polaris-Signature: sha256=<lowercase hex>`. When no signing key is configured, the receiver uses ambient transport security (TLS) alone.
- **Base URL(s):** Per destination instance. Resolved from the instance's `secret_ref` at delivery time:
  - URL literal — the secret value IS the target URL.
  - JSON object — `{ "url": "...", "signing_key": "..." }` for signed deliveries.
- **TLS posture:** HTTPS required for production. Plain HTTP is permitted only when the target host is `localhost` / `127.0.0.1` / `::1` (smoke / dev compose). Any other plain-HTTP URL produces a permanent `error_class='policy'` failure that goes straight to the DLQ.

## Supported canonical events

The webhook-sink delivers EVERY canonical event. The receiver decides what to consume; Polaris does not filter by event name.

```text
*  (all canonical events; receiver decides)
```

Events explicitly NOT delivered (across all consumers):

```text
polaris.diagnostics.*  internal-only platform telemetry
```

## Field mapping

There is one mapper for every canonical event: the passthrough mapper. The output payload mirrors the contract in `src/types.ts`:

| Wire field | Source | Notes |
|---|---|---|
| `version` | constant `1` | wire format pin; bumps when the envelope shape changes |
| `delivery.delivery_key` | runtime-supplied | stable across retries; matches `delivery_records.delivery_key` |
| `delivery.attempt` | runtime-supplied | 1-based attempt counter |
| `delivery.sent_at` | runtime-supplied | UTC ISO timestamp when Polaris sent THIS attempt |
| `delivery.consumer.vendor` | manifest `webhook` | pinned |
| `delivery.consumer.consumer_version` | manifest `v1` | pinned |
| `delivery.consumer.mapper_version` | manifest `v1` | pinned |
| `delivery.consumer.deliverer_version` | manifest `v1` | pinned |
| `delivery.consumer.normalize_version` | manifest `v2` | see "The resolved.events flip" below |
| `event` | the full normalized event | byte-for-byte; the receiver picks what it needs |

The mapper produces the payload with empty placeholders for the runtime-supplied delivery fields; the deliverer overwrites them per attempt via `stampDelivery` so the wire payload carries authoritative values.

## The resolved.events flip (WE77L4R8)

Webhook-sink reads `resolved.events`, the output of the identity and enrichment stages, rather than `analytics.events`. It is the first consumer to move and for a while the only one: it is the transparency exemplar, so a receiver pointed at it sees exactly what a vendor mapper sees, with nothing vendor-shaped in the way.

**Added to `event`:**

| Field | Meaning |
|---|---|
| `event.identity.profile_id` | Polaris's identifier for the person. Stable across devices and sessions. |
| `event.identity.canonical_customer_id` | The customer id the identity stage resolved, which may differ from the one this event's producer sent. |
| `event.traits` | Profile traits as of enrichment. **Redacted and hashed on the same rules as `properties`** — a `traits.email` arrives as `traits.email_sha256`, never in the clear. `null` covers both "no traits" and "snapshot over the size guard". |
| `event.traits_version` | Version of that snapshot; what keeps a historical delivery explainable after the profile has moved on. |
| `event.enrichment.geo` | Country/region/city derived from the IP, plus a `source` naming the backend — or `no_ip` / `no_lookup`, so a null geo is never ambiguous between "not attempted" and "found nothing". |

**Changed in `event` — read this one:**

`event.best_identity` now answers "who is this event about?" with the platform's conclusion instead of the producer's observation. Both halves move:

```
  before                        after
  user_id      "cus_1"     ->   canonical_customer_id  "cus_1"
  anonymous_id "anon_1"    ->   profile_id             "0193...aa"
```

The first is a relabelling — same value, more accurate name. The second is a **different key**: an anonymous visitor seen on three devices used to be three `best_identity` values and is now one. A receiver deduplicating on `best_identity.value` will see its keys change shape at the flip. That is the intended improvement, but it is a change, not an addition, and it is why webhook-sink flipped first and alone.

Nothing else in the payload moves. `test/dual-run-diff.test.ts` runs four representative envelopes down both paths and fails on any difference outside the two lists above, so this section cannot quietly go stale.

## Normalization rules

Standard shared primitives — no consumer-specific normalization beyond the platform defaults:

```text
email       hashEmailLower (lowercase + sha256)
phone       hashPhoneE164 (E.164 + sha256)
externalId  canonicalizeExternalId + sha256 (when enabled)
timestamp   isoToEpochMs (carried alongside the ISO string)
```

Webhook-sink hashes both email and phone before exposing them to receivers (`identityHashing: { email: true, phone: true }`). Raw values are passed through alongside the hashes per the shared normalize layer's defaults.

## Vendor dedupe

The runtime supplies a stable Polaris delivery key (`pdk_*` shape via `buildDeliveryKey`) that is stable across retries of the same `(destination_id, event_id, consumer identity)` tuple. The mapper additionally surfaces `dedupe_key = normalized.event_id` so receivers that maintain their own dedupe table key on the original event id rather than the Polaris-internal hash.

- **Vendor dedupe field:** none — receivers may use `delivery.delivery_key` (request-scoped) and/or `event.event_id` (event-scoped) at their discretion.
- **Polaris source field:** `event_id` (UUIDv7 from the envelope) and `delivery_key` (built by the runtime).
- **Stability across retries:** confirmed — the destination runtime (P9-001) preserves the delivery key across attempts; the mapper is pure, so the same envelope always yields the same `event_id` on the wire.

## Consent slot mapping

The webhook-sink does not gate by consent — the receiver decides. The manifest's `required_consent` block flags every dimension as `false`, so the normalize layer never drops an envelope on consent for this consumer.

| Canonical | Vendor field | Default when canonical absent |
|---|---|---|
| `consent.marketing` | `event.consent.dimensions[?dimension == 'marketing'].granted` | absent-as-`true` (per normalize layer) |
| `consent.personalization` | `event.consent.dimensions[?...].granted` | absent-as-`true` |
| `consent.analytics` | `event.consent.dimensions[?...].granted` | absent-as-`true` |

Receivers that need a consent-aware contract should read the `event.consent` block on the payload directly.

## Error class table

| HTTP / network signal | Classification | `error_class` | Behavior |
|---|---|---|---|
| 2xx | `accepted` | n/a | write `delivery_records` row with status `accepted` |
| 408 | `failed_retryable` | `timeout` | re-throw → KafkaJS retries; DLQ at `dead_letter_threshold` |
| 429 | `failed_retryable` | `rate_limit` | re-throw → KafkaJS retries; DLQ at `dead_letter_threshold` |
| 5xx | `failed_retryable` | `transient` | re-throw → KafkaJS retries; DLQ at `dead_letter_threshold` |
| 401 / 403 | `failed_permanent` | `auth` | DLQ immediately; operator triages credentials |
| Other 4xx (400, 404, 410, 422, ...) | `failed_permanent` | `permanent` | DLQ immediately |
| Plain HTTP non-loopback URL | `failed_permanent` | `policy` | DLQ immediately; operator must HTTPS-ify the destination |
| Malformed secret (not a URL, not JSON) | `failed_permanent` | `auth` | DLQ immediately; operator fixes the destination row |
| Network error (ECONNREFUSED, DNS, TLS) | `failed_retryable` | `transient` | re-throw → KafkaJS retries |
| Request timeout (AbortError) | `failed_retryable` | `timeout` | re-throw → KafkaJS retries |

DLQ payloads carry the canonical envelope plus the Polaris headers stamped by `publishToDestinationDlq` (`polaris-destination-id`, `polaris-consumer-version`, `polaris-mapper-version`, `polaris-deliverer-version`, `polaris-normalize-version`, `polaris-delivery-key`). No secret material is ever logged or DLQ-stamped.

## Rate limit profile

The webhook-sink has no vendor-published rate limit because the vendor IS the receiver. Per-instance limits live in the PostgreSQL `destinations` row:

- **Consumer defaults (from `consumer.manifest.yaml`):**
  - `request_timeout_ms`: `5000`
  - `retry_backoff_base_ms`: `250`
  - `retry_backoff_max_seconds`: `300`
  - `max_attempts`: `8`
- **Service knobs (env vars):**
  - `POLARIS_WEBHOOK_SINK_CONSUMER_GROUP` — default `polaris-webhook-sink-v1`
  - `POLARIS_WEBHOOK_SINK_CONCURRENCY` — default `4` (KafkaJS `partitionsConsumedConcurrently`)
  - `POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS` — default `5000`
  - `POLARIS_WEBHOOK_SINK_ALLOW_REPLAY` — default `false`
- **Per-instance knobs (PostgreSQL `destinations` row):**
  - `max_concurrency` — concurrent inflight deliveries
  - `max_rps` — token bucket replenishment rate
  - `retry_policy` — `standard` (default) | future per-policy slots
  - `dead_letter_threshold` — attempt count after which the DLQ kicks in

## Identity field mapping detail

Receivers consume the full normalized `event.identity` block. Both raw and hashed forms are present where applicable:

```text
event.identity.user_id          string | null
event.identity.anonymous_id     string | null
event.identity.email            string | null     (lowercased + trimmed if hashed)
event.identity.email_sha256     string | null     (lowercase hex)
event.identity.phone            string | null     (E.164 if hashed)
event.identity.phone_sha256     string | null     (lowercase hex)
event.best_identity.kind        "user_id" | "email_sha256" | "phone_sha256" | "anonymous_id"
event.best_identity.value       string            (corresponds to the chosen field)
```

Webhook receivers MAY pin to `event.best_identity` when they don't need per-channel routing; receivers that need both hashed-email and user-id (for example, a CRM hookup) MAY read `event.identity` directly.

## Test fixtures

The webhook-sink does not enumerate canonical events (every event is delivered passthrough), so it does not ship per-event `<event>.input.json` / `<event>.output.json` golden pairs the way a vendor consumer (Meta CAPI, GA4) will. The contract is exercised end-to-end through:

```text
test/mapper.test.ts        passes a NormalizedEvent → asserts the wire shape
test/deliverer.test.ts     drives buildWebhookDeliverer with a fake fetch
test/integration.test.ts   runs createDestinationConsumer.handleEvent on
                           in-memory adapters with both URL-secret and
                           {url,signing_key}-secret paths
test/config.test.ts        defaults + override matrix
```

Future vendor consumers should fill the golden-fixture pairs per their event matrix; the webhook-sink's structural tests are sufficient because its mapper is event-agnostic.

## Known divergences from canonical

- **No event filtering.** Every canonical event reaches the receiver, including events a particular receiver does not care about. Receivers MUST be prepared to ignore unrecognised events.
- **Mapper-supplied `dedupe_key` equals `event_id`.** Vendor consumers typically derive their own dedupe key from the vendor's idempotency contract; webhook-sink does not, because the receiver is not vendor-aware.
- **Identity hashing is on by default.** Some webhook receivers want raw email/phone instead of (or in addition to) hashes; that is handled by the normalize layer's shared `keepRaw` behavior and by passing both forms on the payload. Receivers that need raw-only can read `event.identity.email` / `event.identity.phone` directly.
- **No app-channel branching** (deliberate). The vendor consumers (Meta CAPI, TikTok, GA4, Braze) infer a mobile-app channel from `event.context.app_*` slots and stamp vendor-specific wrapper fields accordingly. Webhook-sink is passthrough — receivers that care about app-source events read `event.context.app_*` directly off the canonical envelope. No web/app routing happens at this consumer.

## Vendor API changelog

```text
Vendor release notes URL:                  n/a (vendor-agnostic)
Vendor API version this consumer targets:  n/a
Last vendor-side compatibility check:      n/a
```

## Migration notes

n/a — v1 is the initial release.
