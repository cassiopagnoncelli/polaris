/**
 * IP address helpers: validation and log-safe hashing.
 *
 * Migrated from `sync/legacy/geoip-enricher/v1/src/ip.ts` with ONE
 * change in role, which is worth stating because it is a privacy
 * improvement rather than a port detail.
 *
 * The legacy processor emitted `source_ip_hash` on every `enriched.geoip`
 * event, so an unsalted SHA-256 of every observed IP landed in the
 * warehouse and stayed there. The `geo` block on the spine envelope has
 * no hash field at all (`geoEnrichmentSchema` is `.strict()`: country,
 * region, city, source), so this stage PERSISTS no hash. What remains is
 * the log-safe reference: when the enricher needs to say something about
 * an address in a log line, it says the hash.
 *
 * That narrower role matters. An unsalted SHA-256 over the 32-bit IPv4
 * space is trivially reversible by brute force, so the digest is not a
 * privacy control on its own — it is a correlation handle whose blast
 * radius is now bounded by log retention instead of warehouse retention.
 * Salting it would break nothing here (nothing joins on it any more), but
 * a salt that lives in config is a semantic parameter in disguise; if a
 * future reader needs cross-run correlation, that is the moment to decide
 * where the salt lives.
 *
 * The raw IP is never logged, at any level, and never leaves this stage:
 * it stays where it already was, on `context.ip` of the event itself.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";

/**
 * Validate and normalise an IP-shaped string. Returns the normalised
 * form or `null` when the value is not a syntactically valid IPv4 or
 * IPv6 address.
 *
 * Only whitespace is stripped. IPv6 is deliberately NOT canonicalised:
 * `2001:db8::1` and its fully-expanded form are left as they arrived, so
 * a lookup backend sees exactly the string the ingester observed. (The
 * mmdb reader parses either form itself, so the choice costs nothing on
 * the lookup side and keeps hashes stable against the source event.)
 */
export function parseIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (isIP(trimmed) === 0) return null;
  return trimmed;
}

/**
 * Lowercase hex SHA-256 of the supplied IP — 64 characters, always.
 *
 * Used ONLY to reference an address in a log line. See the module header
 * for why this stage stores no hash anywhere else.
 */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip, "utf8").digest("hex");
}
