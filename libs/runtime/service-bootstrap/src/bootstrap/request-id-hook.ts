import type { FastifyInstance } from "fastify";

import { resolveRequestId } from "./request-id.js";

/**
 * Header name used by Fastify's `genReqId` to surface the resolved request
 * ID back to the caller. The bootstrap mirrors it on the reply via an
 * `onSend` hook for cross-service correlation.
 */
export const RESPONSE_REQUEST_ID_HEADER = "x-request-id" as const;

/**
 * Install the request-ID generator and response-header echo onto a Fastify
 * instance.
 *
 * - Reads `x-polaris-request-id` and `x-request-id` from incoming headers.
 * - Falls back to a freshly generated UUIDv7 when neither is present (or
 *   the supplied value is not UUID-shaped).
 * - Echoes the resolved value back to the client on every response.
 *
 * The bootstrap factory wires this in by default; callers building a custom
 * Fastify instance can still call this helper directly.
 */
export function installRequestIdHook(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply) => {
    reply.header(RESPONSE_REQUEST_ID_HEADER, request.id);
  });
}

/**
 * Fastify `genReqId` implementation. The signature matches Fastify's option
 * shape so callers can plug it straight into `fastify({ genReqId })`.
 */
export function genReqId(req: { headers: Readonly<Record<string, unknown>> }): string {
  return resolveRequestId(req.headers);
}
