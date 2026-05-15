# `@polaris/consumer-ga4-v1` changelog

## v1.0.0 — initial release (P9-004)

- Third real-vendor consumer of the destination runtime (`@polaris/shared-destinations`, P9-001); follows the structure pioneered by `@polaris/consumer-meta-capi-v1` (P9-003) and `@polaris/consumer-tiktok-v1` (P9-005).
- Maps the canonical Polaris event subset {`payment.approved`, `checkout.started`, `user.identified`} into GA4 Measurement Protocol events {`purchase`, `begin_checkout`, `login`}.
- Stages composed:
  - `normalize/v1` — shared layer; GA4-specific normalization is minimal (Measurement Protocol consumes `client_id` / `user_id` as raw opaque strings, no hashing). Identity hashing flags are off so the normalize layer skips `email_sha256` / `phone_sha256` production for this consumer.
  - `mapper/v1` — per-event canonical → GA4 payload builder (`name` + `params`). For `purchase`, the canonical `transaction_id` (or `order_id` fallback) lands on both the vendor `params.transaction_id` slot AND the Polaris-side dedupe key so GA4 dedupes cross-channel attempts against the same purchase.
  - `deliverer/v1` — HTTP POST to `www.google-analytics.com/mp/collect?measurement_id=<id>&api_secret=<secret>` with the request body wrapping the mapped payload in `{ client_id, events: [...] }`. GA4 returns HTTP 204 No Content on success; the deliverer treats every 2xx (incl. 204) as `accepted`.
- Secret shape: JSON `{ measurement_id, api_secret }` resolved through `@polaris/shared-secrets`. The plaintext api_secret never lands in PostgreSQL or audit_records (defensive `redactToken` sweep on every `vendor_response_summary`).
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
