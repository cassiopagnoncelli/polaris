/**
 * Stable Problem Details codes the auth layer emits.
 *
 * The catalog mirrors `COMMON_PROBLEM_CODES` in
 * `@polaris/runtime-service-bootstrap`; we redeclare them locally so the
 * ingester's wire contract documents are self-contained and changes here are
 * caught by the ingester's own tests rather than leaking through the shared
 * package.
 *
 * Codes are kebab-case and never localized — SDK retry logic relies on them.
 * They are intentionally narrow: the auth layer maps every reason it rejects
 * a request to one of these three codes. We do not differentiate
 * `revoked_key`, `mismatched_environment`, etc., because doing so leaks
 * information an attacker can use to enumerate valid prefixes.
 */
export const AUTH_PROBLEM_CODES = {
  /** No API key header was present on the request. */
  missingApiKey: "missing_api_key",
  /**
   * The API key was rejected. Surfaced for: malformed header, no matching
   * `api_key_id`, revoked row, hash mismatch, algorithm mismatch. All map to
   * the same code so producers cannot enumerate which arm failed.
   */
  invalidApiKey: "invalid_api_key",
  /**
   * The auth dependency (PostgreSQL) is unavailable. Surfaced as 503 so SDKs
   * retry with backoff rather than treat the key as bad.
   */
  authUnavailable: "auth_unavailable",
} as const;

export type AuthProblemCode = (typeof AUTH_PROBLEM_CODES)[keyof typeof AUTH_PROBLEM_CODES];
