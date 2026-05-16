# `@polaris/consumer-meta-capi-v1` changelog

## v1.1.0 — additive event-matrix expansion (3BBTUM7W)

- Added `signup.completed` → `CompleteRegistration` mapper. Custom data populates `currency` + `predicted_ltv` (minor → major) when both are present on the canonical envelope; otherwise empty.
- Added `subscription.renewed` → `Subscribe` mapper. Custom data populates `currency`, `value` (from `amount_minor` / legacy `amount`), `predicted_ltv`, and `order_id` (from `subscription_id`).
- Extended `MetaCapiCustomData.predicted_ltv?: number` slot — additive on the wire shape; existing mappers ignore it.
- No deliverer or descriptor identity changes; v1 contract preserved.

## v1.0.0 — initial release (P9-003)

- First real-vendor consumer of the destination runtime (`@polaris/shared-destinations`, P9-001).
- Maps the canonical Polaris event subset {`payment.approved`, `checkout.started`, `user.identified`} into Meta CAPI events {`Purchase`, `InitiateCheckout`, `Lead`}.
- Stages composed:
  - `normalize/v1` — shared layer (email + phone sha256, identity hashing on, defensive second-pass redaction) plus Meta-specific `action_source` inference (`website` for browser source types, `app` for mobile, `system_generated` for backend-emitted events).
  - `mapper/v1` — per-event canonical → Meta payload (`user_data` / `custom_data`) builders. Vendor dedupe keys on the canonical `event_id`.
  - `deliverer/v1` — HTTP POST to `graph.facebook.com/<vendor_api_version>/<pixel_id>/events` with `access_token` query parameter; HMAC signature not required by CAPI.
- Secret shape: JSON `{ pixel_id, access_token, test_event_code? }` resolved through `@polaris/shared-secrets`. The plaintext access token never lands in PostgreSQL or audit_records.
- Error class mapping:
  - HTTP 2xx → accepted
  - HTTP 408 / 429 / 5xx → failed_retryable (timeout / rate_limit / transient)
  - HTTP 401 / 403 → failed_permanent (auth)
  - Other 4xx → failed_permanent (permanent)
  - Network errors / timeouts → failed_retryable (transient)
  - Malformed secret → failed_permanent (auth)
- Pinned per-stage versions: `normalize_version=v1`, `mapper_version=v1`, `deliverer_version=v1`.
- Reserved DLQ topic family: `destination.meta-capi.v1.dlq`.
- Targets Meta Graph API version `v22.0`. When Meta breaks compatibility, a new consumer version (`v2`) is required; v1 stays as the migration reference per `docs/architecture/06-destinations.md` "Version coexistence and migration".

Unsupported canonical events in v1 (will be added per task or in a future minor version): `signup.completed`, `subscription.renewed`, `support.ticket.opened`. Events not in the supported set produce `mapped_failed` records with `error_class='mapping'`; the runbook documents the operator path.
