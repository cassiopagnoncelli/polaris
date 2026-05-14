/**
 * OpenAPI hook for the control-plane API.
 *
 * The control-plane API ships a thin OpenAPI document derived from the
 * Fastify routes registered in `app.ts`. P6-000 ships only the auth
 * + gate + whoami surface; subsequent P6 tasks (keys, sources,
 * destinations, replays) extend the document by adding more routes —
 * Fastify reflects them through the same `/openapi.json` endpoint.
 *
 * We don't ship a static doc at this stage (no business routes yet); the
 * hook stays a no-op until P6-002 lands the first vertical slice. The
 * shape mirrors the ingester's `defaultOpenApiSetup` so the future
 * extension is a copy-paste from the ingester rather than a fresh
 * design.
 */
import { NOOP_OPENAPI_SETUP, type OpenApiSetup } from "@polaris/shared-service-bootstrap";

export const controlPlaneOpenApiSetup: OpenApiSetup = NOOP_OPENAPI_SETUP;
