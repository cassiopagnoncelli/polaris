import { STATUS_CODES } from "node:http";

import { DEFAULT_PROBLEM_TYPE_BASE, type ProblemBody, type ProblemOptions } from "./types.js";

/**
 * Throwable error carrying RFC 7807 Problem Details.
 *
 * Route handlers throw `ProblemError` for request-level failures. The shared
 * Fastify error handler installed by `bootstrapService` catches them, attaches
 * the per-request `request_id`, and serialises the body as
 * `application/problem+json`.
 *
 * `request_id` is intentionally optional on the constructor because handlers
 * usually do not know the request scope at the point a service-layer function
 * decides to throw. The error handler fills it in from the request.
 *
 * @example
 * ```ts
 * if (!apiKey) {
 *   throw new ProblemError({
 *     status: 401,
 *     code: "missing_api_key",
 *     title: "Missing API key",
 *     detail: "Send the API key in the `x-polaris-api-key` header.",
 *   });
 * }
 * ```
 */
export class ProblemError extends Error {
  public override readonly name = "ProblemError";

  /** HTTP status code. */
  public readonly status: number;

  /** Stable machine-readable problem code. */
  public readonly code: string;

  /** Optional problem-class URI override. */
  public readonly type: string | undefined;

  /** Short human-readable title. */
  public readonly title: string;

  /** Optional human-readable detail (mirrors `Error.message` when undefined). */
  public readonly detail: string | undefined;

  /** Optional pre-resolved request_id. The handler fills it when missing. */
  public readonly request_id: string | undefined;

  /** Free-form extension members merged onto the response body. */
  public readonly extensions: Readonly<Record<string, unknown>> | undefined;

  /**
   * Optional pointer to the original error that caused the failure. Logged
   * for operator triage; never serialised onto the response body.
   */
  public override readonly cause: unknown;

  constructor(
    options: Omit<ProblemOptions, "request_id"> & {
      request_id?: string;
      cause?: unknown;
    },
  ) {
    super(options.detail ?? options.title ?? STATUS_CODES[options.status] ?? "Problem");
    this.status = options.status;
    this.code = options.code;
    this.type = options.type;
    this.title = options.title ?? STATUS_CODES[options.status] ?? "Error";
    this.detail = options.detail;
    this.request_id = options.request_id;
    this.extensions = options.extensions;
    this.cause = options.cause;
  }

  /**
   * Convert this error into a Problem Details body, filling in `request_id`
   * from the call site if the throw site did not know it.
   */
  toBody(request_id: string, typeBase: string = DEFAULT_PROBLEM_TYPE_BASE): ProblemBody {
    const code = this.code;
    const type = this.type ?? `${typeBase}${code}`;
    const body: Record<string, unknown> = {
      type,
      title: this.title,
      status: this.status,
      code,
      request_id: this.request_id ?? request_id,
    };
    if (this.detail !== undefined) {
      body["detail"] = this.detail;
    }
    if (this.extensions !== undefined) {
      for (const [key, value] of Object.entries(this.extensions)) {
        if (key in body) continue;
        body[key] = value;
      }
    }
    return Object.freeze(body) as ProblemBody;
  }
}

/**
 * Narrow an unknown error to `ProblemError`.
 */
export function isProblemError(value: unknown): value is ProblemError {
  return value instanceof ProblemError;
}
