/**
 * External-ID normalization helpers shared across destination consumers.
 *
 * "External ID" is the vendor-agnostic name for a producer-controlled
 * stable identifier: typically `customer_id` (logged-in user) or
 * `anonymous_id` (browser-issued). Vendors require it hashed; the
 * canonicalization is a trim — case is preserved because the producer
 * controls the ID format and lowercase folding could collapse
 * legitimately distinct IDs (`Cust_001` vs `cust_001`).
 *
 * Used by:
 *   - Meta CAPI            (`external_id` user_data field, SHA-256 hex)
 *   - TikTok Events API    (`external_id`, SHA-256 hex)
 *   - GA4                  (`user_id`/`client_id` — the producer-supplied
 *                          form is sent as-is unless the consumer's
 *                          mapper explicitly hashes; the GA4 mapper
 *                          chooses)
 */

import { sha256Hex } from "./hashing.js";

/**
 * Trim surrounding whitespace from an external ID. Case is preserved.
 * Throws when the trimmed value is empty.
 */
export function canonicalizeExternalId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new RangeError("external_id: trimmed value is empty");
  }
  return trimmed;
}

/**
 * Trim + SHA-256-hash an external ID. Returns lowercase hex.
 * Used wherever a vendor's `external_id` slot expects a hashed customer ID.
 */
export function hashExternalId(id: string): string {
  return sha256Hex(canonicalizeExternalId(id));
}
