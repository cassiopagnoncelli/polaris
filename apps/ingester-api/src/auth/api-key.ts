/**
 * API key wire format and resolved-context types.
 *
 * Polaris API keys are presented to the ingester as a single opaque string in
 * the `x-polaris-api-key` request header. The string is split into:
 *
 *   - `api_key_id`: the public lookup prefix (also the primary key on the
 *     `api_keys` table). Visible in audit records, logs, and CLI output.
 *   - `secret`: the high-entropy tail. NEVER stored. Compared against the
 *     argon2id hash on the resolved row through {@link verifyApiKeyHash}.
 *
 * The two halves are separated by a single `.` so the prefix is easy to copy
 * around (logs, CLI) without ever including the secret. The shape is
 * deliberately simple — P6-003 will commit to a final format with version
 * marker if/when needed; today's contract is "id dot secret".
 *
 * @see docs/architecture/02-control-plane.md "API Keys"
 * @see docs/architecture/01-event-contract.md "Trusted Metadata"
 */

/**
 * Header the ingester reads the API key from. Matches the redaction list in
 * `libs/observability/logger/src/redaction.ts` so the raw key never appears in
 * log lines, even when the request log is dumped at debug level.
 */
export const API_KEY_HEADER = "x-polaris-api-key" as const;

/** Separator between the public id and the secret tail. */
const API_KEY_SEPARATOR = ".";

/**
 * Result of pulling the `x-polaris-api-key` header off the wire and parsing
 * it. The shape is internal to the auth layer; outer code receives a fully
 * resolved {@link AuthenticatedRequestContext} instead.
 */
export interface ParsedApiKey {
  /** Public lookup id. Safe to include in logs and audit records. */
  readonly apiKeyId: string;
  /** Secret tail. NEVER log, persist, or echo in error responses. */
  readonly secret: string;
}

/**
 * Resolved authentication context attached to a Fastify request once the
 * `preHandler` hook accepts the key. Downstream route handlers stamp these
 * fields onto the canonical envelope — producers may not send them.
 *
 * The shape is intentionally narrow: callers only need the trusted
 * `(project_id, environment, source)` tuple from the resolved row. Fields the
 * lifecycle CLI also needs (status, revoked_at, created_at, ...) stay on the
 * repository's row type and never leak through this interface.
 */
export interface AuthenticatedRequestContext {
  /** Public lookup id of the resolved key. Safe to log. */
  readonly apiKeyId: string;
  /** Stamped onto the canonical envelope. */
  readonly projectId: string;
  /** Stamped onto the canonical envelope. */
  readonly environment: string;
  /** Trusted source descriptor stamped onto the canonical envelope. */
  readonly source: {
    readonly id: string;
    readonly type: string;
  };
}

/**
 * Parse the raw header value into `(api_key_id, secret)`.
 *
 * Trims surrounding whitespace and accepts a single literal `.` between the
 * two halves. Returns `null` for any malformed input — the upstream auth
 * layer maps that to a single `invalid_api_key` Problem Details response so
 * producers cannot probe the format with crafted headers.
 */
export function parseApiKeyHeader(raw: string | undefined): ParsedApiKey | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(API_KEY_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }
  const apiKeyId = trimmed.slice(0, separatorIndex);
  const secret = trimmed.slice(separatorIndex + 1);
  if (apiKeyId.length === 0 || secret.length === 0) {
    return null;
  }
  return { apiKeyId, secret };
}
