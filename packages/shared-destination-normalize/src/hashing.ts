/**
 * Deterministic SHA-256 wrapper for destination normalization.
 *
 * Per `docs/architecture/06-destinations.md` ("Normalization"):
 *
 *   - Normalization is **deterministic and stateless**: same input → same output.
 *   - Normalization runs **before logging**: no structured log line emits the
 *     un-normalized PII.
 *   - Normalization **never calls external services**.
 *
 * This module is the single sanctioned SHA-256 surface for destination
 * normalization. Per-PII canonicalization (lowercase/trim for email,
 * E.164-only for phone) lives in `email.ts` / `phone.ts` / `external-id.ts`;
 * those modules call `sha256Hex` after canonicalizing.
 *
 * The helper takes a string, encodes it as UTF-8, hashes with SHA-256, and
 * returns a lowercase hexadecimal digest. The hex form (not base64) is what
 * Meta CAPI, TikTok Events API, GA4 user-id hashing guidance, and most
 * vendor mappers consume, so producing hex by default avoids per-vendor
 * re-encoding in the mapper layer.
 */

import { createHash } from "node:crypto";

/**
 * SHA-256 hash of `input` returned as a lowercase hexadecimal string.
 *
 * `input` is treated as already-canonicalized: this helper does not
 * lowercase, trim, or otherwise normalize. Use the per-field helpers
 * (`hashEmailLower`, `hashPhoneE164`, `hashExternalId`) which canonicalize
 * before calling this function.
 *
 * @throws RangeError when `input` is empty. An empty input would hash to a
 *   constant value (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`)
 *   that downstream vendors interpret as "anonymous user with that digest" —
 *   a silent identity collision across producers. Callers must screen the
 *   empty case first.
 */
export function sha256Hex(input: string): string {
  if (input.length === 0) {
    throw new RangeError("sha256Hex: empty input would produce a deterministic identity collision");
  }
  return createHash("sha256").update(input, "utf8").digest("hex");
}
