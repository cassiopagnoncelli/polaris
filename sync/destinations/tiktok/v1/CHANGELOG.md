# `@polaris/consumer-tiktok-v1` changelog

## v1.3.0 — canonical `external_id`, and `Pageview` (V87AS)

- `user.external_id` now hashes `identity.canonical_customer_id` and falls back to `identity.user_id`, where it previously hashed `user_id` alone. The join key becomes the identity stage's conclusion rather than one producer's spelling, so two producers naming the same customer differently converge on one TikTok user instead of two. Meta CAPI applies the same rule.
  - **Match-quality note for operators.** On resolved traffic the digest TikTok receives CHANGES for any customer whose `canonical_customer_id` differs from the `customer_id` its producer sends. TikTok re-matches on the new value; audiences built on `external_id` re-populate over the vendor's own lookback rather than instantly. Envelopes with no profile block — `analytics.events` traffic and replays of history — are byte-identical to before.
- Added `page.viewed` → `Pageview` mapper. No `properties` block; `page.url` / `page.referrer` come from the flat context, and `event_source` is inferred on the existing rule. TikTok spells the event `Pageview`, unlike Meta's `PageView`.
  - **Volume note for operators.** `page.viewed` is typically a project's highest-volume event, and an instance with no `routing.subscriptions` configured subscribes to everything — so this mapping starts delivering views on deploy, with no config change to trigger it. TikTok documents the Events API around 2000 events/minute/pixel. An instance that should not carry views names the events it wants under the `tiktok` namespace's `routing.subscriptions.events`; `max_rps` on the destination row remains the per-instance throttle.
- Corrected `event_time` in all five `test/fixtures/*.output.json` goldens: they read `1778587200` (2026-05-12) against an `occurred_at` of 2026-05-14, whose true epoch is `1778760000`. The same two-day error is present in the meta-capi and ga4 goldens and is not touched here.
- `test/golden.test.ts` now pins the `page-viewed` pair to what `createDestinationConsumer` emits. The goldens were illustrative and unexecuted, which is exactly why a wrong `event_time` survived in three connectors; the one pair whose digests are real is now the one a test reads.
- `test/integration.test.ts` gains the first end-to-end proof that a profile-trait email and phone reach `user.email` / `user.phone` through `createDestinationConsumer` and the real normalize stage — the path 1VEL3 opened, which the mapper goldens cannot reach because they start from an already-prepared `NormalizedEvent`.
- No deliverer or descriptor identity changes; v1 contract preserved. `normalize_version` stays at the v3 that 1VEL3 set.

## v1.2.0 — mobile-app `event_source` inference (WH7LZ0WZ)

- `inferEventSource` now returns `app` when any `context.app_*` slot on the normalized envelope is populated. `app` wins over `web` so native-app webviews are attributed correctly.
- Depends on the additive `EnvelopeAppContext` extension to `@polaris/delivery-normalize`'s `FlatContext` (landed alongside G7ZCYLL6).
- No deliverer or descriptor identity changes; v1 contract preserved.

## v1.1.0 — additive event-matrix expansion (XJ8BT875)

- Added `signup.completed` → `CompleteRegistration` mapper. Both `user.identified` and `signup.completed` now map to TikTok's `CompleteRegistration`; canonical `event_id` keeps the two streams distinct on the receive side.
- Added `subscription.renewed` → `Subscribe` mapper. Properties populate `currency`, `value` (from `amount_minor` / legacy `amount`), and `order_id` (from `subscription_id`).
- New `TIKTOK_EVENT_SUBSCRIBE` constant exported from `src/mapper.ts`.
- No deliverer or descriptor identity changes; v1 contract preserved.

## v1.0.0 — initial release (P9-005)

- Second real-vendor consumer of the destination runtime (`@polaris/delivery-destinations`, P9-001); follows the structure pioneered by `@polaris/consumer-meta-capi-v1` (P9-003).
- Maps the canonical Polaris event subset {`payment.approved`, `checkout.started`, `user.identified`} into TikTok Events API events {`Purchase`, `InitiateCheckout`, `CompleteRegistration`}.
- Stages composed:
  - `normalize/v1` — shared layer (email + phone sha256, identity hashing on, defensive second-pass redaction) plus TikTok-specific `event_source` inference (`web` for browser source types, `app` for mobile, `crm` for backend-emitted events).
  - `mapper/v1` — per-event canonical → TikTok payload (`user` / `properties`) builders. Vendor dedupe keys on the canonical `event_id`.
  - `deliverer/v1` — HTTP POST to `business-api.tiktok.com/open_api/<vendor_api_version>/event/track/` with `Access-Token: <token>` header; body wraps payload in `{ event_source, event_source_id, data: [...], test_event_code? }`.
- Secret shape: JSON `{ access_token, pixel_id, test_event_code? }` resolved through `@polaris/runtime-secrets`. The plaintext access token never lands in PostgreSQL or audit_records.
- Error class mapping:
  - HTTP 2xx → accepted
  - HTTP 408 / 429 / 5xx → failed_retryable (timeout / rate_limit / transient)
  - HTTP 401 / 403 → failed_permanent (auth)
  - Other 4xx → failed_permanent (permanent)
  - Network errors / timeouts → failed_retryable (transient)
  - Malformed secret → failed_permanent (auth)
- Pinned per-stage versions: `normalize_version=v1`, `mapper_version=v1`, `deliverer_version=v1`.
- Reserved DLQ topic family: `destination.tiktok.v1.dlq`.
- Targets TikTok Events API version `v1.3`. When TikTok breaks compatibility, a new consumer version (`v2`) is required; v1 stays as the migration reference per `docs/architecture/06-destinations.md` "Version coexistence and migration".

Unsupported canonical events at the v1.0.0 release (`signup.completed` and `subscription.renewed` shipped in v1.1.0, `page.viewed` in v1.3.0): `signup.completed`, `subscription.renewed`, `support.ticket.opened`. Events not in the supported set produced `mapped_failed` records with `error_class='mapping'`; H05QEWIB later changed that to `skipped_unmapped` with a null `error_class`. The runbook documents the operator path.
