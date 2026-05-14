/**
 * Bearer-token authentication for the control-plane API.
 *
 * Per `docs/architecture/02-control-plane.md` "Operator Identity and
 * Audit Actor", every incoming request resolves to a `ResolvedActor`.
 * The control-plane API trades the CLI's env-var transport for an
 * HTTP bearer header:
 *
 *   Authorization: Bearer polaris_ot_<uuidv7>.<base64url-32B>
 *
 * Resolution semantics mirror the CLI resolver in
 * `@polaris/shared-control-plane/src/resolver.ts`:
 *
 *   1. Bearer header absent → `{ source: 'cli', label: 'cli' }`. The
 *      dispatcher gate refuses production-mutating requests in this
 *      state (matches the CLI's "no POLARIS_OPERATOR_TOKEN" fallback).
 *
 *   2. Bearer header malformed (wrong shape) → 401
 *      `invalid_operator_token`. Operator error; surfaced at the wire
 *      layer rather than silently collapsing to `cli`.
 *
 *   3. Bearer parses but the `operator_token_id` is unknown, the row
 *      is revoked, the hash algorithm is wrong, or the secret tail
 *      fails verification → `{ source: 'cli', label: 'cli' }`. Audit
 *      records this as a forged-token attempt; the gate refuses.
 *
 *   4. Bearer parses and the secret verifies → `{ source: 'declared',
 *      label: row.operator_label, tokenId: row.operator_token_id }`.
 *      The gate allows production mutations.
 *
 *   The plaintext token NEVER lands in `request.log` or any other
 *   structured field. The hook attaches the resolved actor on
 *   `request.actor` for downstream consumers (dispatcher gate, audit
 *   recorder, route handlers).
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";

import {
  parseOperatorToken,
  type OperatorTokenRepository,
  type ResolvedActor,
} from "@polaris/shared-control-plane";
import { POLARIS_HASH_ALGORITHM, verifySecret } from "@polaris/shared-secrets";
import { ProblemError } from "@polaris/shared-service-bootstrap";

/** Problem code returned when the bearer header is malformed. */
export const INVALID_OPERATOR_TOKEN_CODE = "invalid_operator_token" as const;

export interface BearerAuthDeps {
  readonly repository: OperatorTokenRepository;
  readonly verify?: (plaintext: string, hash: string, algorithm: string) => Promise<boolean>;
  readonly now?: () => Date;
}

/**
 * Build the `preHandler` hook for bearer-token authentication.
 *
 * Production hosts pass the Kysely-backed repository; tests inject a
 * stub. The hook attaches `request.actor` and returns; it does NOT
 * enforce the production-mutation gate. The gate is a separate
 * preHandler that runs after this one — see `./gate.ts` in this
 * package.
 */
export function createBearerAuthPreHandler(deps: BearerAuthDeps): preHandlerAsyncHookHandler {
  const verify = deps.verify ?? verifySecret;
  const now = deps.now ?? (() => new Date());

  return async function bearerAuthPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const headerToken = readBearerHeader(request);
    if (headerToken === undefined) {
      request.actor = cliFallback();
      return;
    }

    const parsed = parseOperatorToken(headerToken);
    if (parsed === null) {
      throw new ProblemError({
        status: 401,
        code: INVALID_OPERATOR_TOKEN_CODE,
        title: "Invalid operator token",
        detail: "Authorization header is not a valid polaris_ot_<uuidv7>.<secret> bearer token.",
      });
    }

    const row = await deps.repository.findById(parsed.operatorTokenId);
    if (row === null || row.status !== "active" || row.hash_algorithm !== POLARIS_HASH_ALGORITHM) {
      request.actor = cliFallback();
      return;
    }
    const ok = await verify(parsed.rawSecret, row.hash, row.hash_algorithm);
    if (!ok) {
      request.actor = cliFallback();
      return;
    }

    // Best-effort last-used touch. Failure here MUST NOT block the
    // request; the resolver contract is "decide who this is", not
    // "guarantee bookkeeping completeness".
    try {
      await deps.repository.touchLastUsedAt(row.operator_token_id, now());
    } catch {
      // Intentionally swallowed.
    }

    request.actor = {
      source: "declared",
      label: row.operator_label,
      tokenId: row.operator_token_id,
    };
  };
}

function cliFallback(): ResolvedActor {
  return { source: "cli", label: "cli" };
}

function readBearerHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers["authorization"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined;
  const token = trimmed.slice(7).trim();
  return token.length === 0 ? undefined : token;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved operator context attached by the auth hook. */
    actor?: ResolvedActor;
  }
}
