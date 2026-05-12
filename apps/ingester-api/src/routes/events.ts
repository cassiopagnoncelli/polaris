import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";

import { ProblemError } from "@polaris/shared-service-bootstrap";

/**
 * Stable problem code emitted by the post-auth `POST /v1/events` stub.
 *
 * P2-002 wires the auth `preHandler` so authenticated requests reach this
 * handler with `request.auth` populated. The handler still returns 501
 * because the batch validation, dedupe, forbidden-field, and Redpanda
 * publish layers land in P2-003.
 *
 * The code differs from the shell's original `not_implemented` so SDKs and
 * smoke tests can distinguish "authentication still failing" from "auth
 * accepted, ingestion handler still pending".
 */
export const NOT_IMPLEMENTED_AFTER_AUTH_CODE = "not_implemented_after_auth" as const;

/**
 * Backwards-compatible alias for the pre-auth 501 code. Tests that hit the
 * route without an API key still receive `not_implemented` semantics via
 * the auth layer's `missing_api_key` 401, but the export name is preserved
 * so any external import does not break.
 *
 * @deprecated use {@link NOT_IMPLEMENTED_AFTER_AUTH_CODE}.
 */
export const NOT_IMPLEMENTED_CODE = NOT_IMPLEMENTED_AFTER_AUTH_CODE;

export interface RegisterEventsRoutesOptions {
  /**
   * Auth `preHandler` hook returned by `createAuthPreHandler`. The shell
   * left this slot undefined so the ingester boots without PostgreSQL in
   * the very first scaffolding; P2-002 makes it required for any deployment
   * that actually serves traffic.
   */
  readonly authPreHandler: preHandlerAsyncHookHandler;
}

/**
 * Register the `POST /v1/events` ingestion endpoint.
 *
 * Flow on the wire:
 *
 *   1. Auth `preHandler` runs. On failure, the request never reaches the
 *      route body — the Problem error is serialised by the shared error
 *      handler with the per-request `request_id`.
 *   2. On success, `request.auth` is populated with the trusted
 *      `(project_id, environment, source)` tuple resolved from the API key.
 *      The handler returns 501 `not_implemented_after_auth` until P2-003
 *      lands the real batch handler. That code is distinct from the shell's
 *      `not_implemented` so SDKs can tell whether they got past auth.
 *
 * The trusted tuple is intentionally NOT echoed in the 501 body. Producers
 * already know which key they used; echoing the stamped values back risks
 * making them feel authoritative before the publish path actually accepts
 * them.
 */
export function registerEventsRoutes(
  app: FastifyInstance,
  options: RegisterEventsRoutesOptions,
): void {
  app.post("/v1/events", { preHandler: options.authPreHandler }, async (_request, _reply) => {
    throw new ProblemError({
      status: 501,
      code: NOT_IMPLEMENTED_AFTER_AUTH_CODE,
      title: "Ingestion not yet implemented",
      detail:
        "API key authentication succeeded. The batch validation, dedupe, and Redpanda publish handler ships in P2-003.",
    });
  });
}
