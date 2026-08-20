import { POLICY_REASON_PII_CARD, POLICY_REASON_PII_SECRET } from "./reason-codes.js";
import type { PatternRule } from "./types.js";

/**
 * Built-in pattern-based redaction detectors. These are the five detectors
 * mandated by `docs/architecture/01-event-contract.md` "Forbidden-Field
 * Policy / Redact list (pattern-based)".
 *
 * Each detector returns `true` when the candidate value should be redacted.
 * Detectors are pure and stateless. They never log or otherwise carry the
 * candidate value off-stack; they receive the value and the dotted path
 * for path-scoped exclusion and return a boolean.
 *
 * The detectors are conservative on false positives — false positives leak
 * into the redact metric but never cause an event to be dropped. False
 * negatives leak raw values, which the rest of the platform (logger
 * redaction, ClickHouse access control) must defend against in depth.
 */

/**
 * Luhn-valid 13-19 digit PAN in any field other than the explicit
 * `card_number` field. The explicit field is handled by a named redact
 * rule; pattern detection covers PANs that producers mistakenly drop into
 * unrelated fields (e.g. `notes`, `properties.message`).
 */
export const LUHN_PAN_PATTERN: PatternRule = {
  pattern: "luhn_pan",
  reason: POLICY_REASON_PII_CARD,
  note: "Luhn-valid 13-19 digit PAN outside the explicit card_number field",
  test(value, path) {
    if (path.length === 0) return false;
    // The explicit named-field rule handles card_number; skip here to
    // avoid double-redacting on the same field.
    const leaf = path[path.length - 1]?.toLowerCase();
    if (leaf === "card_number" || leaf === "cardnumber") return false;
    if (value.length < 13) return false;

    // Scan for digit runs (with optional spaces or dashes between digits)
    // anywhere in the value. This catches both stand-alone PAN strings
    // ("4111111111111111", "4111-1111-1111-1111", "4111 1111 1111 1111")
    // and PANs embedded in free-form text. Bounded scan length keeps
    // performance predictable on long values.
    const matches = value.match(/[0-9](?:[ -]?[0-9]){12,18}/g);
    if (!matches) return false;
    for (const candidate of matches) {
      const stripped = candidate.replace(/[^0-9]/g, "");
      if (stripped.length >= 13 && stripped.length <= 19 && passesLuhn(stripped)) {
        return true;
      }
    }
    return false;
  },
};

/**
 * AWS access key signatures. Production access keys start with `AKIA`
 * (long-lived IAM user key) or `ASIA` (temporary STS key) followed by 16
 * base32 characters. Detecting either is enough for redaction.
 */
export const AWS_ACCESS_KEY_PATTERN: PatternRule = {
  pattern: "aws_access_key",
  reason: POLICY_REASON_PII_SECRET,
  note: "AWS access key shape: AKIA/ASIA + 16 base32 characters",
  test(value) {
    return /\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/.test(value);
  },
};

/**
 * GitHub token signatures. Modern GitHub tokens use stable prefixes:
 *
 *   ghp_   classic personal access token
 *   gho_   OAuth access token
 *   ghu_   user-to-server access token
 *   ghs_   server-to-server access token
 *   ghr_   refresh token
 *
 * Each is followed by a long URL-safe base62-ish body. We accept 36-255
 * characters of the documented token alphabet after the prefix.
 */
export const GITHUB_TOKEN_PATTERN: PatternRule = {
  pattern: "github_token",
  reason: POLICY_REASON_PII_SECRET,
  note: "GitHub token shape: gh[p|o|u|s|r]_ prefix",
  test(value) {
    return /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/.test(value);
  },
};

/**
 * JWT three-segment base64url shape, outside of `identity.*` paths.
 *
 * Identity-scoped paths legitimately carry JWT-shaped tokens (e.g.
 * `identity.id_token`) under producer control — those are caught by the
 * logger redaction list, not redacted from the event itself. The platform
 * default leaves identity intentionally writable; project overrides may
 * tighten this further.
 */
export const JWT_PATTERN: PatternRule = {
  pattern: "jwt",
  reason: POLICY_REASON_PII_SECRET,
  note: "Three-segment base64url JWT outside identity.*",
  test(value, path) {
    if (path.length > 0 && path[0]?.toLowerCase() === "identity") return false;
    // RFC 7519 / RFC 4648 base64url: A-Z, a-z, 0-9, '-', '_'. Allow
    // optional trailing padding `=` characters. Require the three-segment
    // shape with at least 4-character segments to avoid matching short
    // dot-separated strings.
    return /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}={0,2}\b/.test(value);
  },
};

/**
 * Generic high-entropy 32+ byte hex or base64 strings in unexpected fields.
 *
 * This is the final-fallback secret detector. It scans for either:
 *
 *   - 64+ contiguous hex characters (32 bytes hex-encoded)
 *   - 43+ contiguous base64 / base64url characters with at least 4 bits of
 *     Shannon entropy per character
 *
 * The Shannon-entropy gate keeps the detector from firing on long IDs that
 * happen to be alphanumeric (e.g. UUIDs, ULIDs) without specifically
 * matching them by shape. Field-name exclusions filter out the canonical
 * envelope ID fields where high-entropy values are expected by design.
 */
export const HIGH_ENTROPY_SECRET_PATTERN: PatternRule = {
  pattern: "high_entropy_secret",
  reason: POLICY_REASON_PII_SECRET,
  note: "32+ byte hex / 43+ char base64 with high entropy outside expected ID fields",
  test(value, path) {
    if (isExpectedHighEntropyPath(path)) return false;
    return findHighEntropyRun(value);
  },
};

/**
 * Ordered list of the platform-default pattern-based redactions. The
 * evaluator applies these in order on every string-valued field. Order
 * matters only when two detectors could fire on the same value; the first
 * match wins so we can keep `pii_card` ahead of `pii_secret`.
 */
export const DEFAULT_PATTERN_RULES: readonly PatternRule[] = [
  LUHN_PAN_PATTERN,
  AWS_ACCESS_KEY_PATTERN,
  GITHUB_TOKEN_PATTERN,
  JWT_PATTERN,
  HIGH_ENTROPY_SECRET_PATTERN,
];

// ---------------------------------------------------------------------------
// internal helpers — not exported
// ---------------------------------------------------------------------------

/** Luhn checksum. Operates on a string of digits 0-9. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let n = ch;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Paths where high-entropy values are expected by the canonical envelope.
 * These never trigger the generic-secret detector. Other detectors (Luhn,
 * AWS, GitHub, JWT) still apply.
 */
function isExpectedHighEntropyPath(path: readonly string[]): boolean {
  if (path.length === 0) return false;
  const leaf = path[path.length - 1]?.toLowerCase();
  if (
    leaf === "event_id" ||
    leaf === "anonymous_id" ||
    leaf === "session_id" ||
    leaf === "customer_id" ||
    leaf === "device_id" ||
    leaf === "request_id" ||
    leaf === "trace_id" ||
    leaf === "span_id" ||
    leaf === "replay_job_id" ||
    leaf === "destination_id"
  ) {
    return true;
  }
  return false;
}

/**
 * Scan the candidate string for a 32+ byte hex run or a 43+ char base64
 * run whose Shannon entropy exceeds the threshold. Returns on the first
 * match; longer candidates are not re-scanned.
 */
function findHighEntropyRun(value: string): boolean {
  if (value.length < 43) return false;

  // Hex run: 64+ hex characters. Apply an entropy floor so that low-entropy
  // hex-looking strings (e.g. "aaaa..." or repeated chunks) do not fire.
  // Hex alphabet has 16 symbols, so log2(16) = 4 bits max; a real hash
  // averages ~3.7. 3.0 cleanly excludes "aaaa..." (entropy 0) and short
  // patterns while still catching real hashes.
  const hexMatch = value.match(/[0-9a-fA-F]{64,}/);
  if (hexMatch && shannonEntropy(hexMatch[0]) >= 3.0) return true;

  // Base64 / base64url run: 43+ chars. Demand a sensible entropy floor so
  // that long alphanumeric IDs (UUID-like) do not trigger the detector.
  const b64 = value.match(/[A-Za-z0-9+/_=-]{43,}/);
  if (!b64) return false;
  return shannonEntropy(b64[0]) >= 4.0;
}

/** Shannon entropy in bits per character. Pure math, no allocation in hot path. */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}
