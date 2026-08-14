# `@polaris/consumer-webhook-sink-v1` changelog

## v1.0.0 — initial release (P9-002)

- First real consumer of the destination runtime (`@polaris/shared-destinations`, P9-001).
- POST canonical envelope as JSON to `instance.config.target_url` (resolved from the destination instance's `secret_ref` — the secret value IS the URL when stored in env/secret manager; receivers without a URL secret can use a fixed URL on the destination instance row).
- Optional HMAC-SHA256 signature via `X-Polaris-Signature: sha256=<hex>` when a signing secret is configured.
- Stable `X-Polaris-Delivery-Id` and `X-Polaris-Delivery-Attempt` headers for receiver-side dedupe / observability.
- Error class mapping:
  - HTTP 2xx → accepted
  - HTTP 408 / 429 / 5xx → failed_retryable (transient)
  - HTTP 4xx (other) → failed_permanent (permanent)
  - Network errors / timeouts → failed_retryable (transient)
- Catalogued canonical events handled: `*` (passthrough — webhook-sink does not filter event names; the receiver decides what to consume).
- Pinned per-stage versions: `normalize_version=v1`, `mapper_version=v1`, `deliverer_version=v1`.
- Reserved DLQ topic family: `destination.webhook-sink.v1.dlq`.

The webhook-sink is intentionally the simplest possible consumer: no vendor-specific normalization, no event-name filtering, no batching. It exists to validate the destination runtime end-to-end against a controlled receiver. Future vendor consumers (Meta CAPI v18, GA4, TikTok Events API, Braze) clone the directory shape and add their own mapper + deliverer.
