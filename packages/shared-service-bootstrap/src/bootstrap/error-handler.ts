import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

import { isProblemError, ProblemError } from "../problem/error.js";
import { PROBLEM_CONTENT_TYPE, createProblem } from "../problem/problem.js";
import {
  COMMON_PROBLEM_CODES,
  DEFAULT_PROBLEM_TYPE_BASE,
  type ProblemBody,
} from "../problem/types.js";

/**
 * Options for the shared Fastify error handler.
 */
export interface ProblemErrorHandlerOptions {
  /**
   * Base URI for the `type` field of the Problem body. Defaults to
   * `https://docs.polaris/errors/` per the engineering standards example.
   */
  readonly typeBase?: string;
  /**
   * Whether to log handled errors. The handler always calls `request.log` —
   * this flag only controls whether non-Problem errors get an `error` level
   * line. Defaults to `true`.
   */
  readonly logErrors?: boolean;
}

/**
 * Pick the most appropriate Polaris problem code for an unexpected
 * Fastify/Node error.
 *
 * The Fastify validation pathway sets `error.validation` and `error.statusCode`;
 * other framework errors carry a `statusCode` already. Anything else becomes
 * a generic 500 `internal_error`.
 */
function deriveProblemFromError(
  err: FastifyError | Error,
  request_id: string,
  typeBase: string,
): ProblemBody {
  // Fastify validation errors carry a structured `validation` array and a
  // 400 status code. Surface them as 400 invalid_request with the validation
  // issues attached as an extension member.
  const maybeFastify = err as FastifyError & { validation?: unknown };
  if (Array.isArray(maybeFastify.validation)) {
    return createProblem(
      {
        status: maybeFastify.statusCode ?? 400,
        code: COMMON_PROBLEM_CODES.invalidRequest,
        title: "Invalid request",
        detail: err.message,
        request_id,
        extensions: { validation: maybeFastify.validation },
      },
      typeBase,
    );
  }

  // Any other framework error with an explicit 4xx status code is treated as
  // a request-level failure with a generic invalid_request code.
  const statusCode =
    typeof maybeFastify.statusCode === "number" ? maybeFastify.statusCode : undefined;
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return createProblem(
      {
        status: statusCode,
        code: COMMON_PROBLEM_CODES.invalidRequest,
        title: "Invalid request",
        detail: err.message,
        request_id,
      },
      typeBase,
    );
  }

  // Everything else is a 500. Detail is omitted to avoid leaking internals.
  return createProblem(
    {
      status: statusCode ?? 500,
      code: COMMON_PROBLEM_CODES.internalError,
      title: "Internal server error",
      request_id,
    },
    typeBase,
  );
}

/**
 * Build a Fastify error handler that always emits RFC 7807
 * `application/problem+json` responses.
 *
 * Behavior:
 *
 *   - `ProblemError` instances are serialised with their declared status
 *     and code; the per-request `request_id` is injected from the request.
 *   - Fastify validation errors become `400 invalid_request` problems with
 *     the raw `validation` array attached as an extension member.
 *   - Any other 4xx framework error becomes a generic `invalid_request`
 *     problem with the original status preserved.
 *   - Anything else becomes a `500 internal_error` problem; the original
 *     error is logged at `error` level for operator triage. The detail
 *     field is intentionally omitted so internals never leak to clients.
 */
export function createProblemErrorHandler(options: ProblemErrorHandlerOptions = {}) {
  const typeBase = options.typeBase ?? DEFAULT_PROBLEM_TYPE_BASE;
  const logErrors = options.logErrors ?? true;

  return async function problemErrorHandler(
    err: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const request_id = request.id;

    let body: ProblemBody;
    if (isProblemError(err)) {
      body = err.toBody(request_id, typeBase);
      if (logErrors) {
        request.log.warn(
          { problem: { code: err.code, status: err.status }, err: err.cause ?? err },
          "request rejected with problem",
        );
      }
    } else {
      body = deriveProblemFromError(err, request_id, typeBase);
      if (logErrors) {
        if (body.status >= 500) {
          request.log.error({ err }, "unhandled error mapped to problem response");
        } else {
          request.log.warn(
            { err, problem: { code: body.code, status: body.status } },
            "framework error mapped to problem response",
          );
        }
      }
    }

    return reply
      .code(body.status)
      .header("content-type", `${PROBLEM_CONTENT_TYPE}; charset=utf-8`)
      .send(body);
  };
}

/**
 * Build a Fastify not-found handler that mirrors the Problem Details
 * contract. Fastify's default 404 returns a plain JSON body — using this
 * handler keeps the wire shape uniform with the error handler.
 */
export function createProblemNotFoundHandler(options: ProblemErrorHandlerOptions = {}) {
  const typeBase = options.typeBase ?? DEFAULT_PROBLEM_TYPE_BASE;

  return async function problemNotFoundHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const body = createProblem(
      {
        status: 404,
        code: COMMON_PROBLEM_CODES.notFound,
        title: "Not found",
        detail: `Route ${request.method} ${request.url} is not defined.`,
        request_id: request.id,
      },
      typeBase,
    );
    return reply
      .code(body.status)
      .header("content-type", `${PROBLEM_CONTENT_TYPE}; charset=utf-8`)
      .send(body);
  };
}

/**
 * Re-export for caller convenience.
 */
export { ProblemError };
