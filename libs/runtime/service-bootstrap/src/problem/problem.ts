import { STATUS_CODES } from "node:http";

import {
  COMMON_PROBLEM_CODES,
  DEFAULT_PROBLEM_TYPE_BASE,
  type ProblemBody,
  type ProblemOptions,
} from "./types.js";

/**
 * MIME type required by RFC 7807 for problem responses.
 */
export const PROBLEM_CONTENT_TYPE = "application/problem+json" as const;

/**
 * Build a Problem Details body suitable for `application/problem+json`
 * responses.
 *
 * The result is intentionally a plain immutable object so callers can
 * serialise it with `JSON.stringify`. Missing fields are filled in:
 *
 *   - `type`: `${typeBase}${code}` — defaults to `https://docs.polaris/errors/<code>`.
 *   - `title`: standard HTTP status text from `node:http`.
 *   - `request_id`: required to be supplied; callers without a request scope
 *     should pass a freshly generated UUIDv7 (see `requestId.newRequestId`).
 *
 * Extension members are merged after the canonical fields so callers cannot
 * accidentally overwrite `status` / `code` / `request_id` through `extensions`.
 *
 * @throws {Error} when `request_id` is missing.
 */
export function createProblem(
  options: ProblemOptions,
  typeBase: string = DEFAULT_PROBLEM_TYPE_BASE,
): ProblemBody {
  if (!options.request_id || options.request_id.trim().length === 0) {
    throw new Error(
      "createProblem requires a non-empty `request_id`; the Fastify request scope must populate it.",
    );
  }
  const status = options.status;
  const code = options.code;
  const title = options.title ?? STATUS_CODES[status] ?? "Error";
  const type = options.type ?? `${typeBase}${code}`;

  // Canonical fields go in first so caller extensions never overwrite them.
  const canonical: Record<string, unknown> = {
    type,
    title,
    status,
    code,
    request_id: options.request_id,
  };
  if (options.detail !== undefined) {
    canonical["detail"] = options.detail;
  }

  // Merge caller extensions after stripping any reserved keys.
  if (options.extensions !== undefined) {
    for (const [key, value] of Object.entries(options.extensions)) {
      if (key in canonical) continue;
      canonical[key] = value;
    }
  }

  return Object.freeze(canonical) as ProblemBody;
}

/**
 * Pre-built problem factories for common HTTP failure shapes.
 *
 * Each helper accepts a `request_id` (mandatory) and optional overrides for
 * `detail` and `extensions`. The `code` value is taken from
 * `COMMON_PROBLEM_CODES` so SDK retry tables stay in sync.
 */
export const commonProblems = {
  invalidRequest(
    request_id: string,
    detail?: string,
    extensions?: Readonly<Record<string, unknown>>,
  ): ProblemBody {
    return createProblem({
      status: 400,
      code: COMMON_PROBLEM_CODES.invalidRequest,
      title: "Invalid request",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
    });
  },
  missingApiKey(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 401,
      code: COMMON_PROBLEM_CODES.missingApiKey,
      title: "Missing API key",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  invalidApiKey(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 401,
      code: COMMON_PROBLEM_CODES.invalidApiKey,
      title: "Invalid API key",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  forbidden(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 403,
      code: COMMON_PROBLEM_CODES.forbidden,
      title: "Forbidden",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  notFound(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 404,
      code: COMMON_PROBLEM_CODES.notFound,
      title: "Not found",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  methodNotAllowed(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 405,
      code: COMMON_PROBLEM_CODES.methodNotAllowed,
      title: "Method not allowed",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  unsupportedMediaType(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 415,
      code: COMMON_PROBLEM_CODES.unsupportedMediaType,
      title: "Unsupported media type",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  payloadTooLarge(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 413,
      code: COMMON_PROBLEM_CODES.payloadTooLarge,
      title: "Payload too large",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  rateLimited(
    request_id: string,
    detail?: string,
    extensions?: Readonly<Record<string, unknown>>,
  ): ProblemBody {
    return createProblem({
      status: 429,
      code: COMMON_PROBLEM_CODES.rateLimited,
      title: "Rate limited",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
    });
  },
  requestTimeout(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 408,
      code: COMMON_PROBLEM_CODES.requestTimeout,
      title: "Request timeout",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  internalError(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 500,
      code: COMMON_PROBLEM_CODES.internalError,
      title: "Internal server error",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
  serviceUnavailable(request_id: string, detail?: string): ProblemBody {
    return createProblem({
      status: 503,
      code: COMMON_PROBLEM_CODES.serviceUnavailable,
      title: "Service unavailable",
      request_id,
      ...(detail !== undefined ? { detail } : {}),
    });
  },
} as const;
