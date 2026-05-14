/**
 * Local types for the webhook-sink consumer.
 *
 * Kept narrow: the mapper produces a `WebhookPayload`, the deliverer
 * consumes it. The runtime never inspects the payload contents.
 */

import type { NormalizedEvent } from "@polaris/shared-destination-normalize";

/**
 * Vendor-side payload shape — what we actually POST as the request body.
 *
 * Webhook receivers vary wildly; v1's contract is "the full normalized
 * event under `event`, plus a stable `delivery` envelope the receiver
 * can use for dedupe + traceability". Future consumer versions may
 * change the body shape; the receiver pins itself to a version via the
 * destination instance's `consumer_version` config knob.
 */
export interface WebhookPayload {
  /** Wire format version stamped on every payload. */
  readonly version: 1;
  /** Polaris delivery envelope — receiver dedupe + audit metadata. */
  readonly delivery: {
    /** Stable across retries; matches `delivery_records.delivery_key`. */
    readonly delivery_key: string;
    /** 1-based attempt counter. */
    readonly attempt: number;
    /** UTC ISO timestamp when Polaris sent THIS attempt. */
    readonly sent_at: string;
    /** Vendor + stage versions, for receiver-side compatibility checks. */
    readonly consumer: {
      readonly vendor: string;
      readonly consumer_version: string;
      readonly mapper_version: string;
      readonly deliverer_version: string;
    };
  };
  /** The full normalized event from `@polaris/shared-destination-normalize`. */
  readonly event: NormalizedEvent;
}

/**
 * Webhook receiver configuration resolved at delivery time.
 *
 * Carried inside the secret value (so production rotation works through
 * the existing secret resolver) AND/OR as plain instance fields when the
 * receiver does not need a signing secret.
 *
 * `secret_ref` resolution rules:
 *
 *   - When the resolved secret is a URL (starts with `https://`), the
 *     consumer treats it as the target URL with no HMAC signing.
 *   - When the resolved secret is a JSON document of shape
 *     `{ "url": string, "signing_key": string }`, the consumer POSTs to
 *     `url` and signs the body with HMAC-SHA256(signing_key, body).
 *
 * No other secret shapes are supported in v1.
 */
export interface ResolvedWebhookConfig {
  /** Where to POST. HTTPS in production; HTTP allowed only when the */
  /** target URL host is `localhost`. */
  readonly url: string;
  /** When present, body is signed with HMAC-SHA256. */
  readonly signingKey?: string;
}
