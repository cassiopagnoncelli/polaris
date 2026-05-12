import { DEFAULT_PATTERN_RULES } from "./patterns.js";
import { POLICY_REASON_PII_CARD, POLICY_REASON_PII_SECRET } from "./reason-codes.js";
import type { ForbiddenFieldPolicy, NamedFieldRule } from "./types.js";

/**
 * Platform-default forbidden-field policy.
 *
 * The platform defaults are **intentionally narrow** per
 * `docs/architecture/01-event-contract.md` "Forbidden-Field Policy /
 * default-capture, narrow-reject":
 *
 *   - Only `pii_card` and `pii_secret` named fields are rejected.
 *   - Card-number partials redact through a single named rule.
 *   - The five pattern detectors live on the redact list; pattern matches
 *     never reject an event.
 *
 * IBAN, raw email, raw phone, names, IP, and user agent are **not** on
 * platform defaults. Projects opt into stricter handling through an
 * override file.
 */

/**
 * Named-field reject rules — platform defaults.
 *
 * Each rule names a field by leaf name. Matching is case-insensitive on
 * the leaf segment, and the rule fires at any depth, so a producer that
 * nests a forbidden field under `properties.payment.cvv` still trips it.
 */
const DEFAULT_REJECT_RULES: readonly NamedFieldRule[] = [
  // pii_card: CVV / CVC family and the explicit "full card number" field.
  { field: "cvv", reason: POLICY_REASON_PII_CARD, note: "card verification value" },
  { field: "cvc", reason: POLICY_REASON_PII_CARD, note: "card verification code" },
  {
    field: "card_security_code",
    reason: POLICY_REASON_PII_CARD,
    note: "card verification value (alternate spelling)",
  },
  {
    field: "card_number_full",
    reason: POLICY_REASON_PII_CARD,
    note: "full PAN explicit field — producers must use card_number with first6/last4 instead",
  },

  // pii_secret: password and the credential/session families.
  { field: "password", reason: POLICY_REASON_PII_SECRET, note: "raw password" },
  { field: "passwd", reason: POLICY_REASON_PII_SECRET, note: "raw password (alternate spelling)" },
  { field: "pwd", reason: POLICY_REASON_PII_SECRET, note: "raw password (alternate spelling)" },
  {
    field: "authorization",
    reason: POLICY_REASON_PII_SECRET,
    note: "raw Authorization header value",
  },
  {
    field: "authorization_header",
    reason: POLICY_REASON_PII_SECRET,
    note: "raw Authorization header value (alternate spelling)",
  },
  {
    field: "session_cookie",
    reason: POLICY_REASON_PII_SECRET,
    note: "raw session cookie blob",
  },
  {
    field: "cookie",
    reason: POLICY_REASON_PII_SECRET,
    note: "raw cookie blob — producers must not forward cookies into events",
  },
  {
    field: "private_key",
    reason: POLICY_REASON_PII_SECRET,
    note: "private key body",
  },
  {
    field: "priv_key",
    reason: POLICY_REASON_PII_SECRET,
    note: "private key body (alternate spelling)",
  },
  {
    field: "pem_private_key",
    reason: POLICY_REASON_PII_SECRET,
    note: "PEM-encoded private key body",
  },
];

/**
 * Named-field redact rules — platform defaults.
 *
 * Only one entry on platform defaults: the explicit `card_number` field.
 * Producers may legitimately send a card number alongside `first6` /
 * `last4` partials; the raw value is redacted but the partials remain.
 */
const DEFAULT_REDACT_NAMED_RULES: readonly NamedFieldRule[] = [
  {
    field: "card_number",
    reason: POLICY_REASON_PII_CARD,
    note: "raw PAN — keep first6/last4 partials if producer supplied them",
  },
];

/**
 * Platform-default forbidden-field policy. Exported through the package
 * index so the policy file at `catalog/policy/forbidden-fields.ts` can
 * compose it with project overrides.
 */
export const PLATFORM_DEFAULT_POLICY: ForbiddenFieldPolicy = Object.freeze({
  reject: DEFAULT_REJECT_RULES,
  redactNamed: DEFAULT_REDACT_NAMED_RULES,
  redactPatterns: DEFAULT_PATTERN_RULES,
});
