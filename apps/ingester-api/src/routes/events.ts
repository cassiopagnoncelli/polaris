import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";

import { ProblemError } from "@polaris/shared-service-bootstrap";

import { AUTH_PROBLEM_CODES } from "../auth/index.js";
import type { IngestHandler } from "../ingest/handler.js";

/**
 * Legacy 501 code retained for backwards compatibility with the P2-001 / P2-002
 * scaffolds. The real handler now returns per-event batch results; the constant
 * stays exported so any downstream consumer (smoke harness, SDK debug log)
 * that recognised it from the shell does not break on upgrade.
 *
 * Tests against P2-003 wiring never trip this code — it remains only as a
 * sentinel for documentation continuity.
 */
export const NOT_IMPLEMENTED_AFTER_AUTH_CODE = "not_implemented_after_auth" as const;

/** @deprecated retained for the same reason as {@link NOT_IMPLEMENTED_AFTER_AUTH_CODE}. */
export const NOT_IMPLEMENTED_CODE = NOT_IMPLEMENTED_AFTER_AUTH_CODE;

export interface RegisterEventsRoutesOptions {
  /**
   * Auth `preHandler` hook returned by `createAuthPreHandler`. Runs before
   * the handler body so the trusted `(project_id, environment, source)`
   * tuple is on `request.auth`.
   */
  readonly authPreHandler: preHandlerAsyncHookHandler;
  /** Built ingest handler — composed at app startup. */
  readonly handler: IngestHandler;
}

/**
 * Register `POST /v1/events`.
 *
 * Flow:
 *
 *   1. Auth `preHandler` runs. On failure, the request never reaches the
 *      body — the Problem error is serialised by the shared error handler
 *      with the per-request `request_id`.
 *   2. On success, `request.auth` is populated. The handler:
 *      - parses the batch envelope
 *      - validates each event independently against the canonical envelope
 *        and the declared `schema_version`
 *      - applies the forbidden-field policy (reject vs redact)
 *      - performs the short-window dedupe claim
 *      - publishes accepted events to Redpanda `raw.events`
 *      - returns per-event accepted/rejected results
 *
 * Partial acceptance is non-negotiable: one invalid event does not block
 * the rest of the batch.
 */
export function registerEventsRoutes(
  app: FastifyInstance,
  options: RegisterEventsRoutesOptions,
): void {
  app.post("/v1/events", { preHandler: options.authPreHandler }, async (request, reply) => {
    if (request.auth === undefined) {
      // Defensive: the preHandler should have either set `request.auth` or
      // thrown a Problem. Treat the missing context as a server-side bug.
      throw new ProblemError({
        status: 503,
        code: AUTH_PROBLEM_CODES.authUnavailable,
        title: "Authentication context missing",
        detail: "The ingester reached the route body without resolving the API key.",
      });
    }

    const { status, body } = await options.handler.handle(request.body, {
      auth: request.auth,
      receivedAt: new Date(),
      requestId: request.id,
    });

    reply.status(status);
    return body;
  });
}
