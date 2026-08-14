# `@polaris/consumer-braze-v1` changelog

## v1.2.0 — mobile-app `device_id` anchoring (5UCTHNCR)

- The mapper now stamps `device_id` on `events[]` / `purchases[]` / `attributes[]` entries when the canonical envelope reports an app source. The value is the first non-null of `context.app_idfv` → `context.app_gaid` → `context.app_idfa` (iOS Vendor Identifier preferred — UUID format).
- For logged-in mobile users (`external_id` resolves AND envelope is app-source) the device_id rides ALONGSIDE `external_id` so Braze stitches the anonymous device-anchored profile into the identified profile.
- For not-yet-logged-in mobile users (no `external_id`, no `user_alias`) the device_id becomes the PRIMARY identifier on the entry — previously these events landed as `skip` outcomes. The identifier ladder is now `external_id` → `user_alias` → `device_id`; events with none of the three still skip.
- The mapper does NOT set a per-event `platform` slot. Braze REST `/users/track` has no documented `platform` field on track entries; the device_id family (IDFV vs GAID) is the operator-visible signal Braze uses to bucket anonymous app sessions.
- No deliverer or descriptor identity changes; v1 contract preserved.

## v1.1.0 — `user_alias` mapping for email-only / phone-only identities (BJPQSPE5)

- The mapper now emits a `user_alias` entry when `external_id` cannot be derived but `identity.email` or `identity.phone` is present. Email wins when both are populated.
- `external_id` becomes optional on `BrazeEventObject`, `BrazePurchaseObject`, and `BrazeAttributeObject`; the new optional `user_alias` field is the email-only / phone-only fallback. Braze accepts exactly one of the two per entry; the mapper enforces that contract.
- Skip-reason strings change from `no_external_id_for_braze_*` to `no_identifier_for_braze_*` to reflect that the mapper now checks both external_id and user_alias before skipping.
- Tests updated: cases that previously asserted `skip` for email-only / phone-only events now assert `mapped` with a `user_alias` body.
- No deliverer or descriptor identity changes; v1 contract preserved.

## v1.0.0 — initial release (P9-006)

- Third real-vendor consumer of the destination runtime (`@polaris/shared-destinations`, P9-001); follows the structure pioneered by `@polaris/consumer-meta-capi-v1` (P9-003) and refined by `@polaris/consumer-tiktok-v1` (P9-005).
- Maps the canonical Polaris event subset {`payment.approved`, `checkout.started`, `user.identified`} into Braze REST wire families {`purchases[]`, `events[]`, `attributes[]`}.
- Stages composed:
  - `normalize/v1` — shared layer (defensive second-pass redaction, raw email/phone preserved because `identityHashing.email=false` and `identityHashing.phone=false`) — Braze's REST API consumes raw identifiers (the vendor hashes server-side).
  - `mapper/v1` — per-event canonical → Braze family builder. `checkout.started` → `events[]` entry with `name='checkout_started'`; `payment.approved` → `purchases[]` entry; `user.identified` → `attributes[]` entry with `_update_existing_only=false`. Each array entry is keyed by `external_id` (resolved from canonical `customer_id` → `anonymous_id`).
  - `deliverer/v1` — HTTP POST to `rest.<instance>.braze.com/users/track` with `Authorization: Bearer <api_key>` header; body is the `BrazePayload` shape directly (`{ attributes?, events?, purchases? }` with at least one populated).
- Secret shape: JSON `{ instance, api_key }` resolved through `@polaris/shared-secrets`. `instance` is the Braze workspace's instance slug (`iad-01`, `iad-02`, ..., `eu-01`, `eu-02`, ...); the plaintext API key never lands in PostgreSQL or audit_records.
- Error class mapping:
  - HTTP 2xx → accepted
  - HTTP 408 / 429 / 5xx → failed_retryable (timeout / rate_limit / transient)
  - HTTP 401 / 403 → failed_permanent (auth)
  - Other 4xx → failed_permanent (permanent)
  - Network errors / timeouts → failed_retryable (transient)
  - Malformed secret → failed_permanent (auth)
- Pinned per-stage versions: `normalize_version=v1`, `mapper_version=v1`, `deliverer_version=v1`.
- Reserved DLQ topic family: `destination.braze.v1.dlq`.
- Targets Braze's REST `/users/track` endpoint; the vendor publishes the REST surface without a discrete path version, so `vendor_api_version` is recorded as `rest`. A semantic break on Braze's side forces a v2 consumer.

### Known divergence from canonical

Braze does NOT provide a generic vendor-side event dedupe key — its REST contract accepts and re-records duplicate `events[]` entries with the same `(external_id, name, time)` tuple. The Polaris-side delivery-key idempotency in `@polaris/shared-destinations` is the canonical guard against double-delivery; `SPEC.md` documents the contract in full.

Unsupported canonical events in v1 (will be added per task or in a future minor version): `signup.completed`, `subscription.renewed`, `support.ticket.opened`. Events not in the supported set produce `mapped_failed` records with `error_class='mapping'`; the runbook documents the operator path.
