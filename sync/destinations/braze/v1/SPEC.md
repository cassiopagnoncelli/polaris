# Consumer SPEC: `braze` v1

> Third real-vendor consumer of the destination runtime, following the structural template set by `sync/destinations/meta-capi/v1/` (P9-003) and refined by `sync/destinations/tiktok/v1/` (P9-005). Maps the canonical Polaris commerce + lifecycle event subset (`checkout.started`, `payment.approved`, `user.identified`) into Braze's REST `/users/track` payload families (`events[]`, `purchases[]`, `attributes[]`) keyed by `external_id`, and POSTs to `rest.<instance>.braze.com/users/track`. Braze does not provide a generic vendor-side event dedupe; the Polaris-side delivery-key idempotency is the canonical guard against double-delivery.

## Vendor

- **Name:** Braze REST API (`/users/track` endpoint)
- **API version this consumer targets:** `rest` (Braze publishes the REST surface without a discrete path version; the `vendor_api_version: rest` field in `consumer.manifest.yaml` records "the REST contract at the time this consumer shipped")
- **Documentation:** [Braze REST API — User Track endpoint](https://www.braze.com/docs/api/endpoints/user_data/post_user_track) and the broader [REST API reference](https://www.braze.com/docs/api/basics)
- **Auth scheme:** Long-lived REST API key passed as `Authorization: Bearer <api_key>` request header. Braze generates the key from its "Developer Console" → "API Keys" surface; the key is scoped to one workspace + one instance.
- **Base URL(s):** `https://rest.<instance>.braze.com/users/track`. `<instance>` is the workspace's instance slug (`iad-01`, `iad-02`, ..., `eu-01`, `eu-02`, ..., `us-01`, ...). The instance is determined by the workspace's region and is required to route correctly; using the wrong slug returns HTTP 401/403. The host template is overridable via `POLARIS_BRAZE_API_HOST` for staging endpoints; production uses the canonical literal.

## Supported canonical events

```text
checkout.started   →  events[] entry with name='checkout_started'
payment.approved   →  purchases[] entry
user.identified    →  attributes[] entry with _update_existing_only=false
```

Events outside this set produce `mapped_failed` delivery records with `error_class='mapping'`. The runbook (`docs/operations/destination-dlq-triage.md`) covers the operator path; future minor versions will extend the matrix. Notable not-yet-supported events:

```text
signup.completed       not in v1 (future minor — likely a custom event named `signup_completed` plus an `attributes[]` update)
subscription.renewed   not in v1 (future minor — likely a custom event named `subscription_renewed`)
support.ticket.opened  Braze has no native ticket event; would land as a custom `events[]` entry in a future minor
polaris.diagnostics.*  internal-only platform telemetry; never delivered
```

## Field mapping

Each per-event mapper produces a `BrazePayload` populated with exactly one of `attributes[]`, `events[]`, `purchases[]` (single-entry array). The deliverer JSON-serializes the payload directly into the wire body — Braze's `/users/track` accepts that exact shape.

### `checkout.started` → `events[]` entry with `name='checkout_started'`

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `identity.customer_id` (fallback `identity.anonymous_id`) | `external_id` | lowercase + trim | Braze keys all wire entries on `external_id`. App-channel anonymous sessions key on `device_id` instead (5UCTHNCR) |
| `context.app_idfv` (fallback `context.app_gaid` → `context.app_idfa`) | `device_id` | first-non-null wins | App-channel only. Rides alongside `external_id` for logged-in mobile users; replaces `external_id` / `user_alias` when neither resolves on an app-source event |
| n/a (constant) | `name` | none | `checkout_started` per the Braze naming convention |
| `occurred_at` | `time` | passthrough | Braze REST accepts ISO 8601 directly |
| `properties.currency` | `properties.currency` | none | ISO 4217 |
| `properties.total` | `properties.value` | `minorToMajor(value, currency)` | Braze wants decimal; minor → major per ISO 4217 exponent |
| `properties.cart_id` | `properties.cart_id` | none | Preserves the canonical slot for receiver-side queries |
| `properties.items[].quantity` (sum) | `properties.num_items` | sum + integer-check | When present and ≥1 |
| `context.page_url` | `properties.page_url` | none | When populated; absent → omitted |

### `payment.approved` → `purchases[]` entry

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `identity.customer_id` (fallback `identity.anonymous_id`) | `external_id` | lowercase + trim | Braze keys purchases on `external_id`. App-channel anonymous sessions key on `device_id` instead (5UCTHNCR) |
| `context.app_idfv` (fallback `context.app_gaid` → `context.app_idfa`) | `device_id` | first-non-null wins | App-channel only. Same semantics as the `checkout.started` mapping |
| `properties.cart_id` (fallback `properties.order_id` → `properties.transaction_id`) | `product_id` | first-non-null wins | Braze's documentation explicitly allows a single purchase record per transaction; v1 uses `cart_id` as the stable product identifier when no per-line-item breakdown is shipped |
| `properties.currency` | `currency` | none | Required by Braze on every purchase entry |
| `properties.amount_minor` (fallback `properties.amount`) | `price` | `minorToMajor(amount, currency)` | Required by Braze on every purchase entry; `amount` alias supports legacy producers |
| `occurred_at` | `time` | passthrough | ISO 8601 |

If `currency`, `amount`/`amount_minor`, or a derivable `product_id` is missing the mapper returns `kind: 'skip'` with a label-safe reason; the runtime writes a `mapped_failed` record with `error_class='mapping'` and Braze receives no purchase event. Missing identity falls under the same skip branch.

### `user.identified` → `attributes[]` entry

| Canonical field | Vendor field | Normalization | Notes |
|---|---|---|---|
| `identity.customer_id` (fallback `identity.anonymous_id`) | `external_id` | lowercase + trim | Braze keys attribute updates on `external_id`. App-channel anonymous sessions key on `device_id` instead (5UCTHNCR) |
| `context.app_idfv` (fallback `context.app_gaid` → `context.app_idfa`) | `device_id` | first-non-null wins | App-channel only. Same semantics as the `checkout.started` mapping |
| `identity.email` | `email` | passthrough | RAW (NOT hashed) — Braze hashes server-side |
| `identity.phone` | `phone` | passthrough | RAW (NOT hashed) — Braze hashes server-side |
| `context.locale` | `language` | passthrough | Braze stores locale on the user profile |
| `traits.first_name` | `first_name` | producer's spelling | Braze's standard field. Read from the trait bag, not `identity.first_name` — that slot is canonicalized for hashing (`"O'Brien"` → `"obrien"`) and would greet the person by a mangled name |
| `traits.last_name` | `last_name` | producer's spelling | as above |
| `traits.avatar` | `image_url` | passthrough | Segment's `avatar` is Braze's `image_url`; the profile picture the dashboard renders |
| `identity.birthday` | `dob` | `YYYYMMDD` → `YYYY-MM-DD` | Reformatted from the canonical value rather than re-read from `traits.birthday`, so Braze stores the day Meta matched on. `person.ts` has already refused a date that is not a real day |
| `identity.gender` | `gender` | `m` → `M`, `f` → `F` | Braze accepts `M`/`F`/`O`/`N`/`P`; only two are reachable, because the shared canonical form maps onto `m`/`f` and refuses the rest. A non-binary or withheld value omits the slot rather than guessing |
| `identity.country` (fallback `enrichment.geo.country`) | `country` | ISO-3166-1 alpha-2, upper case | Traits win; geo only when the instance sets `location_from_geo` |
| `traits.address.city` (fallback `enrichment.geo.city`) | `home_city` | producer's spelling | The city NAME, so the trait bag again rather than `identity.city` (`"menlopark"`). Traits win; geo only when the instance sets `location_from_geo` |
| n/a (constant) | `_update_existing_only` | constant `false` | Braze creates the profile when one does not already exist (first-touch identification). The same `_update_existing_only=false` applies on app-channel attribute updates so Braze auto-stitches the device-anchored stub profile into the identified profile when an `external_id` later arrives |

## Normalization rules

The shared `@polaris/delivery-normalize` package handles:

```text
email       passthrough (no hashing — Braze REST consumes raw)
phone       passthrough (no hashing — Braze REST consumes raw)
externalId  consumer applies lowercase + trim (Braze documents case-insensitive comparison)
timestamp   isoToEpochMs (the shared layer; mapper emits ISO 8601 directly)
hashing     n/a (Braze REST does not require client-side hashing)
currency    minorToMajor (consumer applies this)
```

`identityHashing.email` is set to `false` and `identityHashing.phone` is set to `false` in `src/descriptor.ts` so the shared normalize layer leaves `identity.email` and `identity.phone` populated with the raw producer-supplied values. The `_sha256` slots remain `null`; this consumer never reads them.

Braze-specific rules (in `src/mapper.ts`):

- **Identifier resolution** — the mapper picks exactly one PRIMARY identifier per entry, in this order:
  - `external_id` is the first non-null of `identity.user_id` (canonical `customer_id`) → `identity.anonymous_id`. Trimmed + lowercased before emission.
  - `user_alias` (BJPQSPE5) is the email-only / phone-only fallback: `{ alias_label: "email", alias_name: ... }` when only `identity.email` is present, or `{ alias_label: "phone", alias_name: ... }` when only `identity.phone` is present. Email wins when both are present and `external_id` is absent. The alias name is raw (unhashed) — Braze does not accept hashed alias names.
  - `device_id` (5UCTHNCR) is the app-channel anonymous fallback: first non-null of `context.app_idfv` → `context.app_gaid` → `context.app_idfa` when the canonical envelope reports an app source. Only used as the primary identifier when neither `external_id` nor `user_alias` resolves on an app-source event (e.g. a not-yet-logged-in mobile SDK user).
  - Events with none of the three still produce a `skip` outcome.
- **Additive `device_id` for logged-in mobile users** (5UCTHNCR) — when the primary identifier is `external_id` (or `user_alias`) AND the canonical envelope is app-source, the mapper also stamps `device_id` on the entry so Braze stitches the anonymous device-anchored profile to the identified profile.
- **`product_id` resolution (purchases)** — first non-null of `properties.cart_id` → `properties.order_id` → `properties.transaction_id`. Braze requires `product_id` on every purchase entry; missing slots produce a `skip` outcome.
- **`name` (events)** — constant per canonical event mapping. v1 emits `checkout_started`; future canonical events get a stable underscore-snake-case Braze name agreed with the receiver.
- **`_update_existing_only=false` (attributes)** — first-touch identification: Braze creates the user profile when one does not already exist. A future minor may surface a per-instance override (e.g. data-engineering-owned destinations may want strict update-only semantics).
- **`location_from_geo` (per-instance, off by default)** — a key in `destinations.config`, read by the mapper, that lets `country` and `home_city` fall back to the geo enrichment when the profile's own address carries neither. Off unless an instance sets it, because geo is derived from the request IP and says where the DEVICE was: someone on holiday is `PT` for a week, and a Braze segment written on `home_city` would move them out of a campaign and back again next month. A brand that prefers approximate location to none opts in per destination; nobody acquires it by upgrading. The profile's own address always wins when it has the value, and a geo country that is not two letters is dropped rather than sent.

## Vendor dedupe

**Braze does NOT provide a generic vendor-side event dedupe key.** Its REST contract accepts and re-records duplicate `events[]` entries with the same `(external_id, name, time)` tuple — the same `purchases[]` entry with the same tuple is recorded twice as two separate purchases, doubling reported revenue. This is the "known divergences from canonical" the manifest references.

The canonical guard against double-delivery is **Polaris-side delivery-key idempotency** in `@polaris/delivery-destinations`:

- The destination runtime computes a stable `delivery_key` per `(destination_id, event_id, consumer_version)` tuple.
- Before invoking the deliverer, the runtime checks the `delivery_records` table for an already-accepted row keyed on the same `delivery_key`. An existing `accepted` row short-circuits to `dropped_idempotency` without re-invoking the deliverer.
- Retries reuse the same `delivery_key` (it is event-stable, not attempt-stable), so a vendor-accepted attempt that the broker re-delivers because the consumer crashed before commit will short-circuit on the next attempt.

The mapper still emits the canonical `event_id` as `dedupe_key` on the `MapperResult` so the destination runtime stamps it onto the `delivery_records` row for receiver-side audit. Braze itself makes no use of the field.

- **Vendor dedupe field:** none.
- **Polaris source field:** canonical `event_id` (UUIDv7) → `delivery_records.dedupe_key` for audit.
- **Stability across retries:** the destination runtime preserves the delivery key across retry attempts; the mapper is pure so the same envelope always produces the same wire payload.

## Consent slot mapping

| Canonical | Vendor field | Default when canonical absent |
|---|---|---|
| `consent.marketing` | implicit (event simply doesn't deliver if denied) | `true` (absent-as-true) |
| `consent.analytics` | not consumed by Braze REST `/users/track` | n/a |
| `consent.personalization` | not consumed by Braze REST `/users/track` | n/a |

The manifest declares `required_consent.marketing = true`. The normalize layer drops events with `consent.dimensions[marketing].granted === false`, so denied-marketing events become `dropped_consent` delivery records before the mapper sees them.

## Error class table

| Vendor signal | Classification | `error_class` | Behavior |
|---|---|---|---|
| HTTP 2xx | `accepted` | n/a | write `delivery_records` row with status `accepted`; response summary surfaced in `vendor_response_summary` |
| HTTP 408 | `failed_retryable` | `timeout` | re-throw → KafkaJS retries; DLQ at `dead_letter_threshold` |
| HTTP 429 | `failed_retryable` | `rate_limit` | re-throw → KafkaJS retries; per-instance `max_rps` typically prevents this |
| HTTP 5xx | `failed_retryable` | `transient` | re-throw → KafkaJS retries |
| HTTP 401 / 403 | `failed_permanent` | `auth` | DLQ immediately; operator rotates `api_key` via the secret-provider runbook |
| Other 4xx | `failed_permanent` | `permanent` | DLQ immediately; usually a contract violation Braze-side (mapper bug, missing required slot, or instance routing error) |
| Network error | `failed_retryable` | `transient` | re-throw |
| Request timeout (AbortError) | `failed_retryable` | `timeout` | re-throw |
| Malformed secret JSON | `failed_permanent` | `auth` | DLQ immediately |
| Mapper `skip` outcome | `mapped_failed` (runtime-level) | `mapping` | Runtime writes a `mapped_failed` record with the supplied reason; no DLQ; the event is intentionally not delivered |

The API key is redacted from every `vendor_response_summary` before it lands in `delivery_records` / `dlq_records` (see `redactApiKey` in `src/deliverer.ts`).

## Rate limit profile

- **Vendor-published limit:** Braze documents the REST API limit at "up to 250,000 requests per hour per workspace" with per-endpoint sub-limits (see Braze's REST API reference for the current limit at the time of operator review).
- **Consumer defaults (from `consumer.manifest.yaml`):**
  - `request_timeout_ms`: `5000`
  - `retry_backoff_base_ms`: `250`
  - `retry_backoff_max_seconds`: `300`
  - `max_attempts`: `8`
- **Service knobs (env vars):**
  - `POLARIS_BRAZE_CONSUMER_GROUP` — default `polaris-braze-v1`
  - `POLARIS_BRAZE_CONCURRENCY` — default `4`
  - `POLARIS_BRAZE_REQUEST_TIMEOUT_MS` — default `5000`
  - `POLARIS_BRAZE_ALLOW_REPLAY` — default `false`
  - `POLARIS_BRAZE_API_HOST` — default `rest.{instance}.braze.com`
- **Per-instance knobs (PostgreSQL `destinations` row):** `max_concurrency`, `max_rps`, `retry_policy`, `dead_letter_threshold` — tune per workspace.

## Identity field mapping detail

Braze's identity model is simpler than Meta CAPI's or TikTok's — only `external_id` is required, and email/phone ride as RAW attribute slots rather than hashed match keys. The shared normalize layer preserves the raw email/phone via `identityHashing: { email: false, phone: false }`; the consumer's mapper reads `identity.email` / `identity.phone` directly.

```text
identity.email   passthrough — Braze's REST API consumes the raw value
identity.phone   passthrough — Braze's REST API consumes the raw value
```

The mapper applies a thin canonicalization for `external_id` (trim + lowercase) to match Braze's documented case-insensitive comparison behavior. No other identity slots are mapped in v1.

Events without `external_id` AND without a `user_alias`-eligible identity (no email, no phone) still produce a `skip` outcome at the mapper. The v1.1 user-alias path (BJPQSPE5) materially shrinks that skip set: any envelope carrying either an email or a phone now produces a Braze entry.

## Test fixtures

```text
connectors/destinations/braze/v1/test/fixtures/normalized.ts                    builders
connectors/destinations/braze/v1/test/fixtures/checkout-started.input.json      canonical event
connectors/destinations/braze/v1/test/fixtures/checkout-started.output.json     Braze payload (illustrative shape)
connectors/destinations/braze/v1/test/fixtures/app-source-purchase.input.json   canonical app-source event (5UCTHNCR)
connectors/destinations/braze/v1/test/fixtures/app-source-purchase.output.json  Braze purchases[] payload with device_id
```

The `.input.json` / `.output.json` pair documents the wire shape for the `checkout.started` mapping. The unit tests assert against computed values so the goldens stay readable without becoming brittle.

The vendor delivery step (network) is exercised against a `fetch` stub in `test/deliverer.test.ts` and `test/integration.test.ts`. An end-to-end test against Braze's sandbox workspace is documented operationally but not run by CI — it requires live Braze credentials.

## Known divergences from canonical

- **Braze REST does NOT provide a generic vendor-side event dedupe key.** Its REST contract accepts and re-records duplicate `events[]` / `purchases[]` entries with the same `(external_id, name, time)` tuple. The Polaris-side delivery-key idempotency in `@polaris/delivery-destinations` is the canonical guard against double-delivery. This is the most important divergence the manifest references; tests assert delivery-record idempotency end-to-end.
- **Braze consumes RAW email/phone**, not sha256-hashed values. Polaris envelopes carry raw email/phone in `identity.email` / `identity.phone`; the shared normalize layer preserves them when `identityHashing` is off (which it is for this consumer). Meta CAPI and TikTok both require sha256-hashed identifiers — Braze is the divergent member of the trio.
- **Braze's `time` slot is ISO 8601, not Unix seconds.** Meta CAPI and TikTok both want seconds; Braze's REST API accepts the ISO string directly so the mapper passes `occurred_at` through unchanged.
- **Braze's `price` is decimal, not minor units.** Mirrors TikTok / Meta — the mapper applies `minorToMajor(amount, currency)` with the ISO 4217 exponent. Zero-decimal currencies (JPY, KRW) pass through unchanged.
- **Braze's wire body is the `BrazePayload` shape directly.** Unlike Meta CAPI (wraps in `{ data: [event] }`) or TikTok (wraps in `{ event_source, event_source_id, data: [payload] }`), Braze accepts `{ attributes?, events?, purchases? }` at the top level with at least one populated. The deliverer JSON-serializes the mapper output directly into the body.
- **Braze's instance slug is part of the URL host, not the API key.** The resolved secret carries `{ instance, api_key }` and the deliverer substitutes `instance` into the host template. Wrong-instance routing returns 401/403 (Braze treats the key as bound to a specific workspace + instance), which the deliverer classifies as `failed_permanent` + `auth`.
- **Per-event mapper `skip` outcomes are surfaced as `mapped_failed` records.** The shared runtime supports `{ kind: 'skip', reason }` from the mapper; v1's purchases mapper uses it when `currency` / `amount` / `product_id` cannot be resolved. The reason string is label-safe and lands in `vendor_response_summary` for operator triage.
- **Braze REST `events[]` / `purchases[]` have no top-level `platform` slot.** Braze's mobile SDKs surface platform metadata via the SDK device handshake; the REST `/users/track` contract does not document a per-event `platform` field. The v1 consumer therefore does NOT set a `platform` slot on app-channel entries — the `device_id` family (IDFV = iOS, GAID = Android) is the operator-visible signal Braze uses to bucket anonymous app sessions.

## Vendor API changelog

```text
Vendor release notes URL:                  https://www.braze.com/docs/release_notes/release_notes
Vendor API version this consumer targets:  rest (Braze does not publish a discrete REST API version)
Last vendor-side compatibility check:      2026-05-14
```

Braze typically maintains backward compatibility on the REST surface; semantic breaks (renamed slots, removed endpoints) require a new consumer version (`v2`). v1 stays as the migration reference; operators flip per-instance `consumer_version` via `polaris destinations update-ops` after draining v1 offsets per `docs/architecture/06-destinations.md` "Version coexistence and migration".

## Migration notes

n/a — v1 is the initial release.

## The resolved.events flip (MVKUP64R)

Braze reads `resolved.events`. One delta.

**`user.identified` forwards profile traits as custom attributes**, from an allowlist keyed by trait path:

| Trait | Braze attribute | |
|---|---|---|
| `tier` | `tier` | |
| `plan` | `plan` | |
| `lifecycle_stage` | `lifecycle_stage` | |
| `lifetime_value` | `lifetime_value` | |
| `first_purchase_at` | `first_purchase_at` | |
| `last_purchase_at` | `last_purchase_at` | |
| `total_orders` | `total_orders` | |
| `name` | `name` | STHB0. The unsplit full name; Braze keys personalization on `first_name` / `last_name` and has no standard slot for this one |
| `title` | `title` | STHB0 |
| `username` | `username` | STHB0 |
| `website` | `website` | STHB0 |
| `created_at` | `created_at` | STHB0. The account's age in the system that owned it before Polaris, not `date_of_first_session` — which is Braze's own observation and Braze's to write |
| `company.id` | `company_id` | STHB0 |
| `company.name` | `company_name` | STHB0 |
| `company.industry` | `company_industry` | STHB0 |
| `company.employee_count` | `company_employee_count` | STHB0 |
| `company.plan` | `company_plan` | STHB0 |

An allowlist rather than a passthrough because Braze's attribute space is a shared namespace an operator curates: forwarding every trait would let a new field in the profile store silently create an attribute in Braze, which is how a vendor account fills with junk nobody can attribute to a decision. Adding a trait to `BRAZE_TRAIT_ATTRIBUTES` is that decision.

The `company` bag is FLATTENED rather than sent as a nested object. Braze's nested custom attributes are an account feature rather than a given, and a flat `company_name` is accepted by every workspace. Flattening is a rename, which is why the table is a map from trait path to attribute name rather than the list it was through MVKUP64R.

Reserved slots are everything Braze itself names — the identifier and control slots (`external_id`, `user_alias`, `braze_id`, `device_id`, `_update_existing_only`) and every standard user-profile field it documents (`country`, `current_location`, `date_of_first_session`, `date_of_last_session`, `dob`, `email`, the four `email_*` subscription flags, `facebook`, `first_name`, `gender`, `home_city`, `image_url`, `language`, `last_name`, `marked_email_as_spam_at`, `phone`, `push_subscribe`, `push_tokens`, `subscription_groups`, `time_zone`, `twitter`). A trait can never write one through the allowlist path. The whole published set rather than the subset this mapper writes, because a custom attribute that collides with a Braze standard field does not fail — it writes the standard field, with whatever the profile store happened to hold. The mapper fills the standard slots it owns itself, from the table under `user.identified` above.

Traits reach a mapper redacted on the same rules as `properties`, and hashed on the destination's own `identityHashing` toggle. Braze's is off, so `traits.email` arrives RAW — which is what its REST API consumes, and what puts `email` on the attribute object for a resolved event whose `properties` carry none (1VEL3). A destination that hashes would see `email_sha256` in its place. `email` is on the reserved list regardless: the mapper sets it from the prepared identity, where `identityFromProperties` has already given a newer producer-supplied address precedence over the snapshot.

An envelope with `traits: null` — not enriched, or a snapshot over the size guard — produces exactly the attribute it produced before the flip.

### What is not mapped

`address.street`, `address.state` and `address.postal_code` are pinned traits with no Braze standard field and no entry in the allowlist. Braze's postal geography is `home_city` and `country`, plus a `current_location` lat/long pair no canonical slot feeds. Sending the remaining three as custom attributes is a namespace decision nobody has asked for; it is one row each in `BRAZE_TRAIT_ATTRIBUTES` when somebody does.
