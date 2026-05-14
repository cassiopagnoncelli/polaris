/**
 * Stable destination delivery key generation.
 *
 * Per `docs/architecture/06-destinations.md` "Delivery Model":
 *
 *   - Consumers generate stable destination delivery keys.
 *   - Consumers pass vendor dedupe fields when supported.
 *   - Polaris does not promise exactly-once delivery to external APIs.
 *
 * The delivery key is the Polaris-owned identifier for one logical
 * delivery (an envelope + destination pair). It is:
 *
 *   - **Stable across retries.** Multiple delivery attempts for the same
 *     `(destination_id, event_id)` produce the same key. Deliverers that
 *     map this onto a vendor `event_id` get vendor-side dedupe for free.
 *
 *   - **Independent of attempt count.** Bumping the retry attempt does
 *     NOT change the delivery key. The vendor sees the same logical
 *     event id even if Polaris had to retry the network call.
 *
 *   - **Deterministic.** The key is derived from `(destination_id,
 *     event_id)` plus a per-stage version tuple so a v1->v2 normalize
 *     change produces a fresh key (the vendor sees the new shape as a
 *     new delivery). This is the right trade-off: a behavior change in a
 *     stage is a NEW logical delivery from the vendor's perspective.
 *
 *   - **Short and URL-safe.** The key fits the `dedupe_key` column's
 *     128-char cap (`delivery_records_dedupe_key_length` CHECK).
 *
 * Implementation: SHA-256(`destination_id|event_id|normalize_version|
 * mapper_version|deliverer_version`) truncated to 32 lowercase hex chars
 * with a `polaris_del_` prefix. The truncation rate gives ~10^-19 collision
 * probability at 10^9 keys — well below the rate at which the vendor's
 * dedupe layer would also catch duplicates.
 */

import { createHash } from "node:crypto";

import type { ConsumerIdentity } from "./types.js";

/** Inputs needed to derive a stable delivery key. */
export interface DeliveryKeyInput {
  readonly destination_id: string;
  readonly event_id: string;
  readonly identity: ConsumerIdentity;
}

/**
 * Stable prefix for Polaris-generated delivery keys. Mirrors the
 * `polaris_*_` prefix convention used by other platform identifiers
 * (`polaris_ak_`, `polaris_dst_`, `polaris_ot_`).
 */
export const DELIVERY_KEY_PREFIX = "polaris_del_";

/**
 * Derive a stable delivery key for `(destination_id, event_id, stage
 * versions)`. The result is safe to stamp into:
 *
 *   - the `delivery_records.dedupe_key` column,
 *   - vendor `event_id` / `client_id` / similar dedupe fields,
 *   - structured logs (the key is value-free; it carries no PII).
 */
export function buildDeliveryKey(input: DeliveryKeyInput): string {
  const material = [
    input.destination_id,
    input.event_id,
    input.identity.normalizeVersion,
    input.identity.mapperVersion,
    input.identity.delivererVersion,
  ].join("|");
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `${DELIVERY_KEY_PREFIX}${digest.slice(0, 32)}`;
}
