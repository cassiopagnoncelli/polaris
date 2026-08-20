/**
 * Email normalization helpers shared across destination consumers.
 *
 * Canonical form for hashing:
 *   1. Strip surrounding whitespace.
 *   2. Lowercase the entire address (vendor consensus for hashed-email
 *      matching: Meta, TikTok, Reddit, Snap, LinkedIn, and most CDPs).
 *
 * Used by:
 *   - Meta CAPI            (`em` user_data field, SHA-256 hex)
 *   - TikTok Events API    (`email` field, SHA-256 hex)
 *   - Reddit Conversions   (`em`, SHA-256 hex)
 *   - LinkedIn / Snap      (lowercase + trim + SHA-256)
 *
 * **Not** the right shape for GA4 user_id, which expects an
 * already-pseudonymized stable identifier supplied by the producer; for
 * GA4 use `hashExternalId` or pass through the producer-supplied ID
 * unchanged.
 *
 * Rules per `docs/architecture/06-destinations.md`:
 *   - Helpers are deterministic and stateless.
 *   - Helpers never log raw PII; only the canonical or hashed form may be
 *     logged if a caller chooses to.
 *   - Hashing uses SHA-256 over the canonical form.
 */

import { sha256Hex } from "./hashing.js";

/**
 * Return the canonical form of an email address: trimmed, lowercased. Use
 * this when a vendor's normalization rules diverge after this stage (e.g.
 * Meta's Gmail-specific stripping of `+suffix` is intentionally **not**
 * applied here; the consumer's `normalize/` adds it). The result is safe
 * to log.
 */
export function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Canonicalize an email and hash it with SHA-256. Returns a lowercase hex
 * digest. Throws when `email` canonicalizes to an empty string (whitespace
 * only) — the empty hash would silently collapse multiple producers'
 * "unknown user" rows to a single vendor identity.
 *
 * Shared by Meta CAPI, TikTok Events, Reddit Conversions, LinkedIn Insight
 * Tag, Snap Conversion API. GA4 user-id hashing uses
 * `hashExternalId` (no lowercase) so it is intentionally not consolidated
 * with this helper.
 */
export function hashEmailLower(email: string): string {
  const canonical = canonicalizeEmail(email);
  if (canonical.length === 0) {
    throw new RangeError("hashEmailLower: canonicalized email is empty");
  }
  return sha256Hex(canonical);
}
