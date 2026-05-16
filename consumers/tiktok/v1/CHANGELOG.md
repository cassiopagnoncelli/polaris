# `@polaris/consumer-tiktok-v1` changelog

## v1.1.0 — additive event-matrix expansion (XJ8BT875)

- Added `signup.completed` → `CompleteRegistration` mapper. Both `user.identified` and `signup.completed` now map to TikTok's `CompleteRegistration`; canonical `event_id` keeps the two streams distinct on the receive side.
- Added `subscription.renewed` → `Subscribe` mapper. Properties populate `currency`, `value` (from `amount_minor` / legacy `amount`), and `order_id` (from `subscription_id`).
- New `TIKTOK_EVENT_SUBSCRIBE` constant exported from `src/mapper.ts`.
- No deliverer or descriptor identity changes; v1 contract preserved.

## v1.0.0 — initial release (P9-005)

- Second real-vendor consumer of the destination runtime (`@polaris/shared-destinations`, P9-001); follows the structure pioneered by `@polaris/consumer-meta-capi-v1` (P9-003).
- Maps the canonical Polaris event subset {`payment.approved`, `checkout.started`, `user.identified`} into TikTok Events API events {`Purchase`, `InitiateCheckout`, `CompleteRegistration`}.
- Stages composed:
  - `normalize/v1` — shared layer (email + phone sha256, identity hashing on, defensive second-pass redaction) plus TikTok-specific `event_source` inference (`web` for browser source types, `app` for mobile, `crm` for backend-emitted events).
  - `mapper/v1` — per-event canonical → TikTok payload (`user` / `properties`) builders. Vendor dedupe keys on the canonical `event_id`.
  - `deliverer/v1` — HTTP POST to `business-api.tiktok.com/open_api/<vendor_api_version>/event/track/` with `Access-Token: <token>` header; body wraps payload in `{ event_source, event_source_id, data: [...], test_event_code? }`.
- Secret shape: JSON `{ access_token, pixel_id, test_event_code? }` resolved through `@polaris/shared-secrets`. The plaintext access token never lands in PostgreSQL or audit_records.
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

Unsupported canonical events in v1 (will be added per task or in a future minor version): `signup.completed`, `subscription.renewed`, `support.ticket.opened`. Events not in the supported set produce `mapped_failed` records with `error_class='mapping'`; the runbook documents the operator path.
