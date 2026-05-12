/**
 * Phone normalization helpers shared across destination consumers.
 *
 * Canonical form for hashing: an E.164 string with a leading `+` followed
 * by 7 to 15 digits (per ITU-T E.164). The producer is responsible for
 * country resolution; this layer refuses to guess.
 *
 * The platform-level decision is intentional: most vendor hashing guidance
 * (Meta, TikTok, Reddit) expects E.164 already. Adding an implicit country
 * code at the destination boundary would collapse different-country numbers
 * onto the same hash for any producer that omits a `+`. Refusing the input
 * surfaces that producer bug as a destination drop rather than a silent
 * cross-country identity collision.
 *
 * Used by:
 *   - Meta CAPI            (`ph` user_data field, SHA-256 hex over E.164)
 *   - TikTok Events API    (`phone_number`, SHA-256 hex over E.164)
 *   - Reddit Conversions   (`ph`, SHA-256 hex)
 *
 * Used differently by GA4 (raw phone is not part of measurement protocol).
 */

import { sha256Hex } from "./hashing.js";

/**
 * Strict E.164 shape: leading `+`, 7-15 digits, no spaces or punctuation.
 * 7 is the lower bound documented by ITU-T E.164 (national-number minimum
 * for any region); 15 is the global cap.
 */
const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;

/**
 * Return `phone` if it matches the strict E.164 form, otherwise throw.
 *
 * The check **rejects** anything that requires guessing a country code:
 *   - bare `(415) 555-0123` style local numbers
 *   - numbers with `00` international prefix instead of `+`
 *   - numbers with embedded extensions (`+15555551234x123`)
 *
 * The reasoning is documented above in the module header.
 */
export function requireE164(phone: string): string {
  const trimmed = phone.trim();
  if (!E164_PATTERN.test(trimmed)) {
    throw new RangeError("phone: input must be in strict E.164 form (`+` followed by 7-15 digits)");
  }
  return trimmed;
}

/**
 * Hash an E.164 phone number with SHA-256. The input MUST already be in
 * E.164 form (`+` + country code + subscriber number). Inputs that are not
 * E.164 are rejected with `RangeError` — this layer never adds an implicit
 * country code.
 *
 * Shared by Meta CAPI, TikTok Events, Reddit Conversions, Snap Conversion.
 */
export function hashPhoneE164(phone: string): string {
  return sha256Hex(requireE164(phone));
}
