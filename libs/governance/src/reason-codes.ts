/**
 * Closed-set reason codes used by the Polaris forbidden-field policy.
 *
 * The set is stable across versions and is the only vocabulary the policy
 * evaluator emits. Both reject decisions (event rejected as a whole) and
 * redact decisions (single field replaced with the redaction sentinel) draw
 * from this set.
 *
 * Per `docs/architecture/01-event-contract.md` ("Reason codes"):
 *
 *   pii_card        full or partial card number
 *   pii_account     bank account or IBAN
 *   pii_secret      detected high-entropy secret
 *   policy          listed by name in the project or platform policy
 *   length          exceeds configured length cap
 *   pattern_match   matched a configured pattern rule
 *
 * The reject batch-response code (`forbidden_field_rejected`) is a separate
 * vocabulary owned by the ingester batch-response surface and is exposed by
 * this module as a sibling constant for callers that need both.
 *
 * @see docs/architecture/01-event-contract.md "Forbidden-Field Policy"
 */

/** Card data (full PAN, partial PAN, CVV/CVC). */
export const POLICY_REASON_PII_CARD = "pii_card";

/** Bank account or IBAN. Not on platform defaults; reserved for project overrides. */
export const POLICY_REASON_PII_ACCOUNT = "pii_account";

/** High-entropy / structured secret (passwords, tokens, keys). */
export const POLICY_REASON_PII_SECRET = "pii_secret";

/** Matched a named-field rule in either platform or project policy. */
export const POLICY_REASON_POLICY = "policy";

/** Exceeded a configured length cap. Reserved for project overrides. */
export const POLICY_REASON_LENGTH = "length";

/** Matched a configured pattern rule (regex / entropy heuristic). */
export const POLICY_REASON_PATTERN_MATCH = "pattern_match";

/**
 * Closed-set tuple of policy reason codes. Exported as a tuple so it can
 * back a Zod enum, a runtime guard, and an exhaustive switch.
 */
export const POLICY_REASON_CODES = [
  POLICY_REASON_PII_CARD,
  POLICY_REASON_PII_ACCOUNT,
  POLICY_REASON_PII_SECRET,
  POLICY_REASON_POLICY,
  POLICY_REASON_LENGTH,
  POLICY_REASON_PATTERN_MATCH,
] as const;

/** Closed-set reason-code type used by the policy evaluator. */
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/**
 * Batch-response reason code returned by the ingester when a named-field
 * reject rule fires. The policy evaluator emits a `decision: 'reject'`
 * outcome carrying a `PolicyReasonCode`; the ingester translates that into
 * this code on the wire.
 */
export const POLICY_BATCH_REASON_FORBIDDEN_FIELD_REJECTED = "forbidden_field_rejected";

/** Runtime guard for the closed reason-code set. */
export function isPolicyReasonCode(value: unknown): value is PolicyReasonCode {
  return typeof value === "string" && (POLICY_REASON_CODES as readonly string[]).includes(value);
}
