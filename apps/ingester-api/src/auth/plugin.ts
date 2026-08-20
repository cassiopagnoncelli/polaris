/**
 * Fastify plugin that authenticates protected routes against the API key
 * store.
 *
 * The plugin runs as a `preHandler` hook on the routes it protects (today,
 * `POST /v1/events`). When the hook accepts the key, it attaches a typed
 * `AuthenticatedRequestContext` to the request and stamps the request log
 * with `(project_id, environment, source_id, api_key_id)`. Route handlers
 * read the context off `request.auth` to stamp the canonical envelope's
 * trusted fields — producers may not send those fields.
 *
 * Rejections become RFC 7807 Problem Details:
 *
 *   - `401 missing_api_key` when the header is absent.
 *   - `401 invalid_api_key` for any other rejection (malformed header,
 *     unknown key, revoked key, hash mismatch). The reason is recorded in
 *     the request log but never exposed in the response — producers cannot
 *     enumerate which arm failed.
 *   - `503 auth_unavailable` when the auth dependency throws (PostgreSQL is
 *     down, the verifier blew up). SDKs retry with backoff on 5xx.
 *
 * The plugin does not log the raw header. The shared logger redaction list
 * already covers `headers["x-polaris-api-key"]`; the plugin additionally
 * never logs the parsed secret tail.
 *
 * @see docs/architecture/02-control-plane.md "API Keys"
 * @see docs/architecture/01-event-contract.md "Trusted Metadata"
 */

import { ProblemError } from "@polaris/runtime-service-bootstrap";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { API_KEY_HEADER, type AuthenticatedRequestContext } from "./api-key.js";
import { AUTH_PROBLEM_CODES } from "./errors.js";
import type { AuthRejection, AuthResult } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Resolved authentication context. Set by the auth `preHandler` hook on
     * protected routes; absent on `/health`, `/ready`, `/metrics`, and any
     * unprotected route. Route handlers MUST treat its absence as a
     * programmer error (the hook should have rejected the request).
     */
    auth?: AuthenticatedRequestContext;
  }
}

/**
 * Signature of the request authenticator. Identical to the return type of
 * `createAuthService(...)`, but redeclared here so route plugins can depend
 * on the type without importing the service module.
 */
export type AuthenticateRequest = (rawHeader: string | undefined) => Promise<AuthResult>;

export interface RegisterAuthPreHandlerOptions {
  /** The authenticator returned by `createAuthService`. */
  readonly authenticate: AuthenticateRequest;
}

/**
 * Build the `preHandler` hook. Exposed as a plain function so callers can
 * attach it route-by-route (`app.post(url, { preHandler }, handler)`) without
 * forcing the whole app through a Fastify decorator.
 */
export function createAuthPreHandler(options: RegisterAuthPreHandlerOptions) {
  const authenticate = options.authenticate;
  return async function authPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const raw = readHeader(request);
    let result: AuthResult;
    try {
      result = await authenticate(raw);
    } catch (err) {
      request.log.error({ err }, "api key authentication dependency failed");
      throw new ProblemError({
        status: 503,
        code: AUTH_PROBLEM_CODES.authUnavailable,
        title: "Authentication unavailable",
        detail: "The ingester cannot resolve API keys right now. Retry with exponential backoff.",
        cause: err,
      });
    }

    if (!result.ok) {
      logRejection(request, result);
      throw new ProblemError({
        status: 401,
        code: result.problemCode,
        title:
          result.problemCode === AUTH_PROBLEM_CODES.missingApiKey
            ? "Missing API key"
            : "Invalid API key",
        detail:
          result.problemCode === AUTH_PROBLEM_CODES.missingApiKey
            ? `Send the API key in the \`${API_KEY_HEADER}\` header as \`<api_key_id>.<secret>\`.`
            : "The provided API key is invalid or revoked.",
      });
    }

    request.auth = result.context;
    bindRequestLog(request, result.context);
  };
}

/**
 * Convenience: attach the `preHandler` to a Fastify instance under a
 * `app.decorate("authPreHandler", ...)` key so route registrars can compose
 * it without re-importing the factory. Optional; routes can also pass the
 * hook directly.
 */
export function decorateAuthPreHandler(
  app: FastifyInstance,
  preHandler: ReturnType<typeof createAuthPreHandler>,
): void {
  app.decorate("authPreHandler", preHandler);
}

declare module "fastify" {
  interface FastifyInstance {
    authPreHandler?: ReturnType<typeof createAuthPreHandler>;
  }
}

function readHeader(request: FastifyRequest): string | undefined {
  const value = request.headers[API_KEY_HEADER];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function bindRequestLog(request: FastifyRequest, context: AuthenticatedRequestContext): void {
  // Pino child loggers are immutable; rebind for the rest of the request.
  request.log = request.log.child({
    project_id: context.projectId,
    environment: context.environment,
    source_id: context.source.id,
    source_type: context.source.type,
    api_key_id: context.apiKeyId,
  });
}

function logRejection(request: FastifyRequest, rejection: AuthRejection): void {
  // Log at warn level so operators can spot probes and configuration drift
  // without drowning the steady stream of accepted requests at info. The raw
  // header is NEVER logged — only the public `api_key_id` (when present) and
  // the categorical reason.
  const bindings: Record<string, unknown> = {
    auth_reason: rejection.reason,
    problem_code: rejection.problemCode,
  };
  if (rejection.apiKeyId !== undefined) {
    bindings["api_key_id"] = rejection.apiKeyId;
  }
  request.log.warn(bindings, "api key authentication rejected");
}
