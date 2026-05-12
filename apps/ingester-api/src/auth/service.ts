/**
 * Auth service: parse -> look up -> verify -> resolve context.
 *
 * The service is framework-agnostic so the Fastify plugin (`plugin.ts`) and
 * unit tests can drive it through the same surface. Callers pass the raw
 * `x-polaris-api-key` header value and receive either a resolved
 * {@link AuthenticatedRequestContext} or a {@link AuthError} that the plugin
 * turns into an RFC 7807 Problem Details response.
 *
 * One responsibility deliberately omitted from this layer: stamping
 * `last_used_at`. Updating that column on every request would put a write
 * back on the hot path and defeat the cache. The lifecycle CLI (P6-003)
 * surfaces it for operator triage; a follow-up task can wire a coalesced
 * out-of-band updater when the operational signal is needed.
 */

import {
  parseApiKeyHeader,
  type AuthenticatedRequestContext,
  type ParsedApiKey,
} from "./api-key.js";
import { AUTH_PROBLEM_CODES, type AuthProblemCode } from "./errors.js";
import { verifyApiKeyHash } from "./hash.js";
import type { ApiKeyRecord, ApiKeyRepository } from "./repository.js";

/**
 * Reason categories the service emits internally. They map 1:1 to a Problem
 * code via {@link reasonToProblemCode}. The service surfaces both the
 * category (for metrics / logs) and the Problem code (for the wire) so the
 * plugin can record either without re-deriving.
 */
export type AuthRejectionReason =
  | "missing_header"
  | "malformed_header"
  | "unknown_key"
  | "revoked_key"
  | "hash_mismatch"
  | "unsupported_algorithm";

export interface AuthRejection {
  readonly ok: false;
  readonly reason: AuthRejectionReason;
  readonly problemCode: AuthProblemCode;
  /** Public api_key_id when one could be parsed; useful for log lines. */
  readonly apiKeyId?: string;
}

export interface AuthSuccess {
  readonly ok: true;
  readonly context: AuthenticatedRequestContext;
}

export type AuthResult = AuthSuccess | AuthRejection;

/**
 * Optional hooks for the auth service. The defaults are sufficient for
 * production; tests can swap the verifier to avoid argon2's CPU cost.
 */
export interface AuthServiceOptions {
  readonly repository: ApiKeyRepository;
  /**
   * Hash verifier override. Defaults to {@link verifyApiKeyHash}. Tests
   * provide a stub so the suite does not pay the argon2 cost.
   */
  readonly verifyHash?: (plaintext: string, hash: string, algorithm: string) => Promise<boolean>;
}

/**
 * Build a stateless auth service. The returned function takes the raw header
 * value and returns a discriminated union (`AuthResult`). Callers do not
 * throw — they translate the rejection into a Problem Details response.
 */
export function createAuthService(options: AuthServiceOptions) {
  const verify = options.verifyHash ?? verifyApiKeyHash;
  const repository = options.repository;

  return async function authenticate(rawHeader: string | undefined): Promise<AuthResult> {
    if (rawHeader === undefined || rawHeader === null || rawHeader === "") {
      return reject("missing_header");
    }
    const parsed: ParsedApiKey | null = parseApiKeyHeader(rawHeader);
    if (parsed === null) {
      return reject("malformed_header");
    }

    const record = await repository.findById(parsed.apiKeyId);
    if (record === null) {
      return reject("unknown_key", parsed.apiKeyId);
    }
    if (record.status !== "active") {
      return reject("revoked_key", parsed.apiKeyId);
    }
    if (record.hashAlgorithm !== "argon2id") {
      return reject("unsupported_algorithm", parsed.apiKeyId);
    }

    const matches = await verify(parsed.secret, record.hash, record.hashAlgorithm);
    if (!matches) {
      return reject("hash_mismatch", parsed.apiKeyId);
    }
    return {
      ok: true,
      context: buildContext(record),
    };
  };
}

function buildContext(record: ApiKeyRecord): AuthenticatedRequestContext {
  return {
    apiKeyId: record.apiKeyId,
    projectId: record.projectId,
    environment: record.environment,
    source: {
      id: record.sourceId,
      type: record.sourceType,
    },
  };
}

function reject(reason: AuthRejectionReason, apiKeyId?: string): AuthRejection {
  const base = {
    ok: false as const,
    reason,
    problemCode: reasonToProblemCode(reason),
  };
  return apiKeyId === undefined ? base : { ...base, apiKeyId };
}

function reasonToProblemCode(reason: AuthRejectionReason): AuthProblemCode {
  return reason === "missing_header"
    ? AUTH_PROBLEM_CODES.missingApiKey
    : AUTH_PROBLEM_CODES.invalidApiKey;
}
