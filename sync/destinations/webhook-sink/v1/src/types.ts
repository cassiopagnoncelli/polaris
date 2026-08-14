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
 * Webhook receiver configuration, parsed from the destination's credential.
 *
 * The target URL rides inside `destinations.secret_value` rather than in a
 * plain column because for this vendor the URL IS the credential — anyone who
 * knows it can post events to the receiver — and because it lets a URL and a
 * signing key rotate together in one `polaris destinations rotate-secret`.
 *
 * Accepted shapes:
 *
 *   - a URL (starts with `https://`): the target, with no HMAC signing;
 *   - a JSON document `{ "url": string, "signing_key": string }`: POST to
 *     `url` and sign the body with HMAC-SHA256(signing_key, body).
 *
 * No other shapes are supported in v1. Anything else is `failed_permanent`
 * with `error_class: 'auth'`.
 */
export interface ResolvedWebhookConfig {
  /** Where to POST. HTTPS in production; HTTP allowed only when the */
  /** target URL host is `localhost`. */
  readonly url: string;
  /** When present, body is signed with HMAC-SHA256. */
  readonly signingKey?: string;
}
