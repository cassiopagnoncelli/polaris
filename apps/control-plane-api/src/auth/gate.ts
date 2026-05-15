/**
 * Production-mutation gate as a Fastify preHandler.
 *
 * Wraps `enforceProductionMutationGate` from
 * `@polaris/shared-control-plane` (the same gate the CLI dispatcher
 * runs) and translates the refusal into an RFC 7807 Problem with
 * `code='production_requires_authenticated_actor'` and HTTP 403.
 *
 * The gate's contract: route declares `mutates: boolean` in its
 * options metadata; when set + the service environment is
 * `production` + `request.actor.source !== 'declared'`, the gate
 * refuses. Otherwise it returns silently and the route handler runs.
 *
 * Hosts wire one of these per protected route via Fastify's `preHandler`
 * array; the `mutates` flag is captured at registration time so a
 * future route can opt out by simply omitting the wrapper.
 */

import {
  enforceProductionMutationGate,
  type GateEnvironment,
  isGateEnvironment,
  type OperatorGateMetricsSink,
  PRODUCTION_GATE_DENIED_REASON,
  ProductionMutationRefusedError,
} from "@polaris/shared-control-plane";
import { ProblemError } from "@polaris/shared-service-bootstrap";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";

export interface MutationGateOptions {
  /** Stable command id used in the refusal message + audit row. */
  readonly commandId: string;
  /** Whether the route mutates control-plane state. */
  readonly mutates: boolean;
  /** Service environment string read from runtime config. */
  readonly environment: string;
  /** Sink for `polaris_operator_gate_denied_total`. Optional during transition. */
  readonly metrics?: OperatorGateMetricsSink;
}

/**
 * Build the production-mutation gate preHandler for a route.
 *
 * When `mutates: false`, the helper returns a no-op handler so the
 * caller can plug it in unconditionally without branching the
 * registration site.
 */
export function createMutationGatePreHandler(
  options: MutationGateOptions,
): preHandlerAsyncHookHandler {
  const env: GateEnvironment | undefined = isGateEnvironment(options.environment)
    ? options.environment
    : undefined;
  if (!options.mutates) {
    return async (_request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      // no-op
    };
  }
  return async function mutationGatePreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const actor = request.actor;
    if (actor === undefined) {
      // Defensive: the bearer-auth hook should have set this. Treat
      // its absence as a wiring bug, not a request-shape issue.
      throw new ProblemError({
        status: 500,
        code: "internal_error",
        title: "Internal error",
        detail: "Mutation gate reached without a resolved actor.",
      });
    }
    try {
      enforceProductionMutationGate({
        command: { id: options.commandId, mutates: options.mutates },
        environment: env,
        actor,
        ...(options.metrics !== undefined ? { metrics: options.metrics } : {}),
      });
    } catch (err) {
      if (err instanceof ProductionMutationRefusedError) {
        throw new ProblemError({
          status: 403,
          code: PRODUCTION_GATE_DENIED_REASON,
          title: "Production requires authenticated actor",
          detail:
            "This route mutates production state. Authenticate via the Authorization: Bearer header with an active operator token, or run against a non-production environment.",
        });
      }
      throw err;
    }
  };
}
