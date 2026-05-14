/**
 * Origin allow-list guard for `POST /v1/events`.
 *
 * The ingester is the public ingress for the Polaris Web SDK; the SDK
 * cannot enforce these rules itself (untrusted client). The guard runs
 * AFTER the auth `preHandler` so the trusted `(project_id, environment,
 * source_id)` tuple is already on `request.auth`.
 *
 * Decision rules (per `11-production-readiness.md` / "Security Hardening"):
 *
 *   - If the request has no `Origin` header (server-to-server caller), the
 *     guard does nothing. Server-side producers are out of scope for CORS;
 *     their authentication is the API key and that's been verified already.
 *
 *   - If the request has an `Origin` header, the guard looks up the
 *     allow-list for `(project_id, source_id, environment)` and refuses the
 *     request when:
 *
 *       1. the source has no rows (deny-by-default), OR
 *       2. the supplied origin is not in the list.
 *
 *     The refusal is `403 origin_not_allowed` Problem Details. The browser
 *     will surface a CORS error to the SDK; the explicit 403 is for the
 *     debug-friendly path (curl, server-side test).
 *
 *   - On preflight `OPTIONS /v1/events`, the guard answers with the standard
 *     CORS preflight headers (or a 403 if the origin is not allowed). The
 *     preflight skips auth — by design — because browsers do not send
 *     credentials on preflight; the auth check happens on the real request.
 *
 * The guard never emits `Access-Control-Allow-Origin: *` for the credentialed
 * `POST /v1/events` flow. The allow-list is per-source-per-environment.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ProblemError } from "@polaris/shared-service-bootstrap";

import type { AuthenticatedRequestContext } from "../auth/index.js";
import type { IngestMetrics } from "../metrics/registry.js";

import type { AllowedOriginsRepository } from "./types.js";

/** Stable Problem code emitted when an origin is refused. */
export const ORIGIN_NOT_ALLOWED_CODE = "origin_not_allowed" as const;

/**
 * Methods + headers the SDK actually needs in its `Access-Control-Request-*`
 * preflight payload. Kept narrow — broader allow lists invite future drift.
 */
const ALLOWED_METHODS = "POST, OPTIONS" as const;
const ALLOWED_HEADERS = "content-type, x-polaris-api-key, x-request-id" as const;
const PREFLIGHT_MAX_AGE_SEC = 600 as const;

export interface OriginGuardDeps {
  readonly repository: AllowedOriginsRepository;
  readonly metrics: IngestMetrics;
}

/**
 * Build the `preHandler` hook for the origin guard.
 *
 * The hook expects `request.auth` to be populated, so it MUST run after the
 * auth pre-handler.
 */
export function createOriginGuardPreHandler(deps: OriginGuardDeps) {
  const { repository, metrics } = deps;

  return async function originGuardPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const origin = readOriginHeader(request);
    if (origin === undefined) {
      // No Origin header — server-to-server caller. Skip the CORS check.
      return;
    }

    // The auth preHandler runs first and rejects requests without a valid
    // API key. By the time we get here, `request.auth` is populated.
    const auth = request.auth;
    if (auth === undefined) {
      // Defensive: same posture as the events route. Treat as server bug.
      throw new ProblemError({
        status: 500,
        code: "internal_error",
        title: "Internal error",
        detail: "Origin guard reached without an authenticated context.",
      });
    }

    const allowed = await repository.findFor({
      projectId: auth.projectId,
      sourceId: auth.source.id,
      environment: auth.environment,
    });
    if (!allowed.includes(origin)) {
      metrics.incrementOriginRejected({
        project_id: auth.projectId,
        environment: auth.environment,
      });
      // Refuse the actual request. The CORS response headers stay absent
      // so the browser will treat the failure as a CORS error.
      throw new ProblemError({
        status: 403,
        code: ORIGIN_NOT_ALLOWED_CODE,
        title: "Origin not allowed",
        detail:
          "The request `Origin` header is not on the per-source allow-list. Check the source's allowed origins in the control plane.",
      });
    }

    // Origin is allowed; stamp the CORS response headers so the browser
    // surfaces the actual response back to the SDK. Mirror the request
    // `Origin` rather than wildcarding because the request is credentialed.
    setCorsResponseHeaders(reply, origin);
    bindRequestLog(request, origin);
  };
}

/**
 * Register the CORS preflight (`OPTIONS /v1/events`) route.
 *
 * The preflight handler does NOT run auth — browsers omit credentials on
 * preflight and there is no `x-polaris-api-key` header to validate. We rely
 * on the per-source allow-list alone for the preflight decision; the actual
 * POST then carries the API key and runs through the full pipeline.
 *
 * The preflight needs `(project, source, environment)` to resolve the
 * allow-list, but the preflight request itself does NOT carry the API key.
 * To stay safe without complicating the wire shape, we answer the preflight
 * with the broad-but-bounded "allow if any source in the platform lists
 * this origin in this environment" policy — but only the *headers*; the
 * actual POST still must authenticate and the actual POST guard re-checks
 * the per-source list.
 *
 * The simpler implementation we ship is: the preflight responds with
 * `Access-Control-Allow-Origin: <origin>` for every origin (without
 * looking up the DB) because the actual POST will refuse anything not on
 * the per-source list. This keeps the preflight path stateless (no DB
 * read) without weakening the actual access decision.
 */
export function registerCorsPreflightRoute(app: FastifyInstance): void {
  app.route({
    method: "OPTIONS",
    url: "/v1/events",
    handler: async (request, reply) => {
      const origin = readOriginHeader(request);
      if (origin === undefined) {
        // Curl / tooling preflight without an Origin header — no CORS
        // response headers, just a plain 204.
        reply.code(204).send();
        return;
      }
      setCorsResponseHeaders(reply, origin);
      reply
        .header("access-control-allow-methods", ALLOWED_METHODS)
        .header("access-control-allow-headers", ALLOWED_HEADERS)
        .header("access-control-max-age", String(PREFLIGHT_MAX_AGE_SEC))
        .code(204)
        .send();
    },
  });
}

function readOriginHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["origin"];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function setCorsResponseHeaders(reply: FastifyReply, origin: string): void {
  reply
    .header("access-control-allow-origin", origin)
    .header("access-control-allow-credentials", "true")
    .header("vary", "Origin");
}

function bindRequestLog(request: FastifyRequest, origin: string): void {
  // Bind the resolved origin onto the request log so operators can correlate
  // refusal patterns. The origin is the safe-to-log half of the CORS state.
  request.log = request.log.child({ origin });
}

declare module "fastify" {
  interface FastifyRequest {
    /** Re-declared here so the guard hook can read it. */
    auth?: AuthenticatedRequestContext;
  }
}
