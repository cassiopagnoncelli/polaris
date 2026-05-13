/**
 * IP address helpers: validation and hashing.
 *
 * PII posture: per `docs/architecture/01-event-contract.md` § "Forbidden-
 * Field Policy", IP is sensitive metadata. The enricher persists only
 * `source_ip_hash` (lowercase SHA-256 hex) on the enriched event and
 * never logs the raw IP — even at debug level. This module wraps the
 * tiny set of helpers the runtime needs to enforce that:
 *
 *   - `parseIp`: structural validation that returns the normalised form
 *     (string the lookup table is keyed on) or `null` when invalid.
 *
 *   - `hashIp`: lowercase SHA-256 hex digest used as `source_ip_hash`
 *     on the enriched event AND on every log line that needs to
 *     reference the IP. The runtime never includes the raw IP in logs.
 *
 * Validation is intentionally relaxed: the goal is to skip the lookup
 * for obvious garbage (random text, empty strings) and reject anything
 * that would falsely match an in-memory fixture. Real IPv4/IPv6 parsing
 * lives in Node's `node:net` module — we delegate.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";

/**
 * Validate and normalise an IP-shaped string. Returns the normalised
 * form (the string the lookup table is keyed on) or `null` when the
 * value is not a syntactically valid IPv4 or IPv6 address.
 *
 * Normalisation rules:
 *   - leading/trailing whitespace stripped,
 *   - IPv6 zone identifiers (`fe80::1%eth0`) are preserved as-is,
 *   - IPv6 mapped IPv4 addresses (`::ffff:8.8.8.8`) are returned in
 *     their full form (Node's `isIP` accepts both shapes; the runtime
 *     hashes whatever form arrived).
 *
 * The function does NOT canonicalise IPv6 to a single representation
 * because doing so would mean the hash for `2001:db8::1` and
 * `2001:0db8:0000:0000:0000:0000:0000:0001` differ. The enricher
 * accepts the form as-supplied; lookup tables key on the same form
 * (the fixtures store the literal string the ingester observed).
 */
export function parseIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (isIP(trimmed) === 0) return null;
  return trimmed;
}

/**
 * Lowercase hex SHA-256 of the supplied IP. Always returns a 64-char
 * string. The runtime stamps this on every emitted enriched event
 * (field `source_ip_hash`) and on every log line that needs to
 * reference the IP without exposing it.
 */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip, "utf8").digest("hex");
}
