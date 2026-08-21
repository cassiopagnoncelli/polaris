# `@polaris/consumer-ga4-v1` changelog

## v1.3.0 — sessions, engagement, consent, page parameters and an unconditional timestamp (1QKDI)

- **GA4 stops receiving sessionless events.** `params.session_id` (derived from `identity.session_id`) and `params.engagement_time_msec` (default `1`, overridable per instance on `destinations.config.engagement_time_msec`) now ride every event. GA4 counts an event towards the standard and realtime reports only when both are present, so the traffic this connector sent had been arriving and appearing nowhere.
- **`timestamp_micros` is unconditional** inside GA4's 72-hour backdating window. It was previously gated on the mapper having populated `engagement_time_msec` — which no mapper did, so it was never sent and GA4 stamped every event with its delivery time. Outside the window the field is omitted and the reason is prefixed onto `vendor_response_summary`; GA4 accepts an out-of-window timestamp and silently discards the event, so the client must enforce it.
- **Page parameters on every event** (`page_location`, `page_referrer`, `page_title` from `context.page`), not only on `page_view` — GA4 attributes an event to a page by reading them off the event itself.
- **Consent Mode v2**: `consent.ad_user_data` from `consent.marketing` and `consent.ad_personalization` from `consent.personalization`, on every request. Absent consent is `GRANTED` per ADR-0001 #54. GA4 still gates on `analytics` alone — forwarding a dimension and gating on it are different jobs.
- **`user_properties`** from the profile-trait snapshot through an operator-curated allowlist (`plan`, `tier`, `lifecycle_stage`, `address.country`), mirroring Braze's `BRAZE_TRAIT_ATTRIBUTES`. GA4's reserved user-property names are screened independently of the allowlist, because one would reject the whole request.
- **`user_id` follows the canonical rule** — `profile.canonical_customer_id` then `identity.customer_id`, the same precedence Meta's `external_id` uses.
- **`page.viewed` → `page_view`.** It previously had no mapper and landed as `skipped_unmapped`. The existing five mappings are unchanged.
- **`ip_override`, `user_agent` and `user_location`** ride the request, from `context.ip`, `context.user_agent` and `enrichment.geo`. All three postdate GA4's launch; each was verified accepted against `/debug/mp/collect`, which rejects unknown keys outright.
- **`Ga4EventPayload` now carries one `wrapper` side channel** instead of two loose top-level keys. The deliverer lifts one block and strips it; a request-level field added to the type can no longer be forgotten in the deliverer's destructure and land inside the `events[]` entry, which GA4 rejects wholesale. `Ga4WireEvent` names what actually goes on the wire.
- The `.output.json` goldens are now asserted end-to-end against the real pipeline rather than being illustrative. A `page-viewed` pair joins them.
- Depends on two additive widenings of `@polaris/delivery-normalize`: `PreparedIdentity.session_id` and `ConsentEvaluation.observed`. Neither changes existing behaviour.

## v1.2.0 — mobile-app stream routing via `app_instance_id` (KCS3ATPC)

- The mapper now synthesizes a wrapper-level `app_instance_id` from `context.app_idfv` (preferred) or `context.app_gaid` when the canonical envelope reports an app source. The slot rides on `Ga4EventPayload.app_instance_id` as a Polaris-internal hint that the deliverer lifts to the request wrapper.
- The deliverer's wrapper builder produces either `{ client_id, events: [...] }` (web stream) or `{ app_instance_id, events: [...] }` (Firebase / app stream). The Polaris-internal `app_instance_id` hint is stripped from the wire event payload.
- The deliverer's URL builder selects `?measurement_id=<id>&api_secret=<secret>` (web stream) or `?firebase_app_id=<id>&api_secret=<secret>` (Firebase / app stream). The Firebase URL flavor only activates when the resolved secret carries `firebase_app_id` AND the mapper produced an `app_instance_id` hint; operators who haven't rotated their secret yet continue to flow app-source events through the web-stream URL with the synthesized `client_id`.
- `ResolvedGa4Secret` gains an optional `firebase_app_id` slot; existing `{measurement_id, api_secret}` secrets keep working unchanged.
- No deliverer or descriptor identity changes; v1 contract preserved.

## v1.1.0 — additive event-matrix expansion

- Added `signup.completed` → `sign_up` mapper. Params populate `method: 'polaris'` so GA4 reports can split Polaris-driven signups out from organic gtag-fired ones; mirrors the `login` mapper shape.
- Added `subscription.renewed` → `subscription_renewed` mapper. GA4 has no recommended event for recurring billing, so v1 emits a snake_case custom event carrying `currency`, `value` (from `amount_minor` / legacy `amount`), and `transaction_id` (from `subscription_id`). GA4 does NOT dedupe custom events; the Polaris-side dedupe_key stays on the canonical `event_id`.
- New `GA4_EVENT_SIGN_UP` and `GA4_EVENT_SUBSCRIPTION_RENEWED` constants exported from `src/mapper.ts`.

## v1.0.0 — initial release (P9-004)

- Third real-vendor consumer of the destination runtime (`@polaris/delivery-destinations`, P9-001); follows the structure pioneered by `@polaris/consumer-meta-capi-v1` (P9-003) and `@polaris/consumer-tiktok-v1` (P9-005).
- Maps the canonical Polaris event subset {`payment.approved`, `checkout.started`, `user.identified`} into GA4 Measurement Protocol events {`purchase`, `begin_checkout`, `login`}.
- Stages composed:
  - `normalize/v1` — shared layer; GA4-specific normalization is minimal (Measurement Protocol consumes `client_id` / `user_id` as raw opaque strings, no hashing). Identity hashing flags are off so the normalize layer skips `email_sha256` / `phone_sha256` production for this consumer.
  - `mapper/v1` — per-event canonical → GA4 payload builder (`name` + `params`). For `purchase`, the canonical `transaction_id` (or `order_id` fallback) lands on both the vendor `params.transaction_id` slot AND the Polaris-side dedupe key so GA4 dedupes cross-channel attempts against the same purchase.
  - `deliverer/v1` — HTTP POST to `www.google-analytics.com/mp/collect?measurement_id=<id>&api_secret=<secret>` with the request body wrapping the mapped payload in `{ client_id, events: [...] }`. GA4 returns HTTP 204 No Content on success; the deliverer treats every 2xx (incl. 204) as `accepted`.
- Secret shape: JSON `{ measurement_id, api_secret }` resolved through `@polaris/runtime-secrets`. The plaintext api_secret never lands in PostgreSQL or audit_records (defensive `redactToken` sweep on every `vendor_response_summary`).
- Error class mapping:
  - HTTP 2xx (incl. 204 No Content) → accepted
  - HTTP 408 / 429 / 5xx → failed_retryable (timeout / rate_limit / transient)
  - HTTP 401 / 403 → failed_permanent (auth)
  - Other 4xx → failed_permanent (permanent)
  - Network errors / timeouts → failed_retryable (transient)
  - Malformed secret → failed_permanent (auth)
- Pinned per-stage versions: `normalize_version=v1`, `mapper_version=v1`, `deliverer_version=v1`.
- Reserved DLQ topic family: `destination.ga4.v1.dlq`.
- Targets GA4 Measurement Protocol (`mp`). Measurement Protocol has no numeric API version; Google evolves the endpoint in place. When GA4 breaks compatibility, a new consumer version (`v2`) is required; v1 stays as the migration reference per `docs/architecture/06-destinations.md` "Version coexistence and migration".

Unsupported canonical events in v1 (will be added per task or in a future minor version): `signup.completed`, `subscription.renewed`, `support.ticket.opened`. Events not in the supported set produce `mapped_failed` records with `error_class='mapping'`; the runbook documents the operator path.

Purchase dedupe behaviour notes:

- `purchase` events carry `params.transaction_id` when the canonical envelope ships `properties.transaction_id` (preferred) or `properties.order_id` (fallback). GA4 deduplicates against this slot.
- The Polaris-side `delivery_records.dedupe_key` mirrors the vendor `transaction_id` for `purchase` so triage queries against duplicates have a stable handle.
- When neither `transaction_id` nor `order_id` is present on a `payment.approved` event, the deliverer still delivers (with no `transaction_id` slot) and the Polaris-side dedupe key falls back to the canonical `event_id`. GA4 will not cross-channel dedupe in that case — the operator path is to back-fill `transaction_id` in the source system.
- `begin_checkout` and `login` events DO NOT promise vendor dedupe — GA4 has no documented universal cross-event dedupe outside `purchase`. The Polaris-side dedupe key for these events is the canonical `event_id`.
