/**
 * Wire format for Polaris operator tokens.
 *
 * The on-wire representation is a single opaque string:
 *
 *   `<operator_token_id>.<raw_secret>`
 *
 * where:
 *
 *   - `operator_token_id` is the public lookup prefix stored in
 *     `operator_tokens.operator_token_id`. Shape: `polaris_ot_<uuidv7>`. The
 *     `polaris_ot_` prefix is distinct from `polaris_ak_` (API keys) so log
 *     scanners and secret detectors can tell the two credential families
 *     apart and so accidental commits are greppable at a glance.
 *
 *   - `raw_secret` is the high-entropy tail. The CLI generates 32 random
 *     bytes and encodes them base64url (no padding) so the secret is URL-
 *     and header-safe. Only the argon2id hash of this value is stored.
 *
 * The full token plaintext is shown ONLY in the one stdout write inside
 * `polaris operators create`. It never appears in logs, audit records,
 * the database, or any subsequent CLI output.
 *
 * The parser here is the single seam the resolver uses to take an env-var
 * value and turn it back into `(operator_token_id, raw_secret)` for hash
 * verification. Owning the parser in this package means the CLI side
 * (`polaris operators create`) and the resolver/dispatcher side speak the
 * exact same shape — there is no second token-format implementation.
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 * @see db/migrations/20260512000009_create_operator_tokens.sql
 */

/**
 * Prefix marker on `operator_token_id`. Distinct from `polaris_ak_` (api
 * keys) and from any future credential prefix.
 *
 * The `operator_tokens_operator_token_id_format` CHECK constraint pins this
 * prefix on the database side; this constant pins it on the application
 * side.
 */
export const OPERATOR_TOKEN_ID_PREFIX = "polaris_ot_";

/**
 * Separator between the public id and the secret tail. Identical to the
 * api-keys separator so log scanners can apply the same `<id>.<secret>`
 * regex to both families.
 */
export const OPERATOR_TOKEN_SEPARATOR = ".";

/**
 * Parse a wire-format operator token into its `(operator_token_id,
 * raw_secret)` parts.
 *
 * Returns `null` on any malformed input — a missing prefix, missing
 * separator, empty parts, or a non-string. The resolver treats `null` the
 * same as "no token present": the actor source falls back to `cli`. We
 * deliberately do NOT throw or log on parse failure so a typo'd
 * `POLARIS_OPERATOR_TOKEN` env var does not crash the dispatcher; the
 * mutation gate refuses the run with a clear "production mutation
 * requires an authenticated operator" message, which is the correct UX.
 *
 * The parser only validates SHAPE. It does not consult the database — the
 * resolver does that next, and we keep the two responsibilities separate
 * so tests can exercise the parser without a DB stand-in.
 */
export interface ParsedOperatorToken {
  readonly operatorTokenId: string;
  readonly rawSecret: string;
}

export function parseOperatorToken(input: unknown): ParsedOperatorToken | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith(OPERATOR_TOKEN_ID_PREFIX)) return null;
  const sepIndex = trimmed.indexOf(OPERATOR_TOKEN_SEPARATOR, OPERATOR_TOKEN_ID_PREFIX.length);
  if (sepIndex < 0) return null;
  const operatorTokenId = trimmed.slice(0, sepIndex);
  const rawSecret = trimmed.slice(sepIndex + OPERATOR_TOKEN_SEPARATOR.length);
  // Both parts must be non-empty and `operator_token_id` must look like
  // `polaris_ot_<something-nonempty>`.
  if (operatorTokenId.length <= OPERATOR_TOKEN_ID_PREFIX.length) return null;
  if (rawSecret.length === 0) return null;
  return { operatorTokenId, rawSecret };
}

/**
 * Format an `(operator_token_id, raw_secret)` pair into the on-wire shape.
 * Used by the CLI's `operators create` to produce the single-stdout-write
 * token string and by tests; production parse paths use
 * {@link parseOperatorToken}.
 */
export function formatOperatorToken(operatorTokenId: string, rawSecret: string): string {
  return `${operatorTokenId}${OPERATOR_TOKEN_SEPARATOR}${rawSecret}`;
}
