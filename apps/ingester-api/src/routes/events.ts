import type { FastifyInstance } from "fastify";

import { ProblemError } from "@polaris/shared-service-bootstrap";

/**
 * Stable problem code emitted by the shell `POST /v1/events` stub.
 *
 * The shell ships this route so SDKs and integration smoke tests can hit a
 * known URL and receive an RFC 7807 Problem Details response with a
 * machine-readable code. P2-002 (API key auth) and P2-003 (batch validation
 * + Redpanda publish) replace the stub with the real handler in place.
 */
export const NOT_IMPLEMENTED_CODE = "not_implemented" as const;

/**
 * Register the `POST /v1/events` ingestion endpoint stub.
 *
 * The shell route returns `501 Not Implemented` with the `not_implemented`
 * Problem code. Behavioural details (auth, validation, dedupe, publish) are
 * deliberately left to P2-002 and P2-003.
 *
 * Keeping the route shape stable now lets:
 *
 *   - SDK integration tests pin a URL without churn between phases
 *   - OpenAPI hooks see a populated path during shell development
 *   - operators verify the service is wired through the load balancer before
 *     ingestion code lands
 */
export function registerEventsRoutes(app: FastifyInstance): void {
  app.post("/v1/events", async (_request, _reply) => {
    throw new ProblemError({
      status: 501,
      code: NOT_IMPLEMENTED_CODE,
      title: "Ingestion not yet implemented",
      detail:
        "POST /v1/events is reserved by the ingester shell. The batch validation and Redpanda publish handler ships in P2-002 / P2-003.",
    });
  });
}
