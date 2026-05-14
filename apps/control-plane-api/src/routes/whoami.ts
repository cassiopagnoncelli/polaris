/**
 * `GET /v1/whoami` — resolved actor view.
 *
 * Returns the actor the bearer-auth preHandler resolved for the
 * request. Useful for CLI debugging ("did the platform actually see my
 * operator token?") and for smoke probes that want to validate a
 * deployment's auth posture without making a mutating call.
 *
 * Non-mutating: bypasses the production-gate. Authentication still
 * runs; an absent header surfaces as `{ source: 'cli', label: 'cli' }`.
 */
import type { FastifyInstance } from "fastify";

import { ProblemError } from "@polaris/shared-service-bootstrap";

export function registerWhoamiRoute(app: FastifyInstance): void {
  app.get("/v1/whoami", async (request, _reply) => {
    if (request.actor === undefined) {
      throw new ProblemError({
        status: 500,
        code: "internal_error",
        title: "Internal error",
        detail: "Whoami route reached without a resolved actor.",
      });
    }
    return {
      actor: {
        source: request.actor.source,
        label: request.actor.label,
        ...(request.actor.tokenId !== undefined ? { token_id: request.actor.tokenId } : {}),
      },
    };
  });
}
