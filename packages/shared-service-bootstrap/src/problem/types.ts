/**
 * RFC 7807 Problem Details type definitions.
 *
 * Polaris services return `application/problem+json` for request-level HTTP
 * failures (per `docs/architecture/09-engineering-standards.md` "HTTP Error
 * Contract"). The on-the-wire shape must always include a stable machine
 * readable `code` and a `request_id` so SDKs can decide retry behavior and
 * operators can correlate logs.
 *
 * Per-event ingestion failures live inside the batch response body and use
 * a different shape — see `libs/spec/` for those reason codes.
 */

/**
 * Default base URL used when constructing the `type` URI for a Problem
 * Details response. Callers can pass a different base when calling
 * `createProblem` for branded error pages.
 */
export const DEFAULT_PROBLEM_TYPE_BASE = "https://docs.polaris/errors/" as const;

/**
 * Catalog of stable Problem `code` values shared by every Polaris service.
 *
 * Codes are kebab-case, machine readable, and never localized. New codes
 * should be added here so SDK retry logic and dashboards stay in sync with
 * the wire contract.
 */
export const COMMON_PROBLEM_CODES = {
  invalidRequest: "invalid_request",
  invalidApiKey: "invalid_api_key",
  missingApiKey: "missing_api_key",
  forbidden: "forbidden",
  notFound: "not_found",
  methodNotAllowed: "method_not_allowed",
  unsupportedMediaType: "unsupported_media_type",
  payloadTooLarge: "payload_too_large",
  rateLimited: "rate_limited",
  requestTimeout: "request_timeout",
  internalError: "internal_error",
  serviceUnavailable: "service_unavailable",
} as const;

export type CommonProblemCode = (typeof COMMON_PROBLEM_CODES)[keyof typeof COMMON_PROBLEM_CODES];

/**
 * Canonical Polaris RFC 7807 Problem body.
 *
 * `type`, `title`, `status`, `code`, and `request_id` are always present.
 * Additional fields are allowed and pass through unchanged so callers can
 * attach validation issues, retry-after hints, etc.
 */
export interface ProblemBody {
  /** Fully qualified URI identifying the problem class. */
  readonly type: string;
  /** Short, human-readable summary of the problem class. */
  readonly title: string;
  /** HTTP status code mirrored into the body so log readers see it. */
  readonly status: number;
  /** Stable machine-readable problem code (`invalid_api_key`, ...). */
  readonly code: string;
  /** Optional human-readable detail; safe for end-user display. */
  readonly detail?: string;
  /** Per-request correlation ID (UUIDv7). */
  readonly request_id: string;
  /** Free-form extension members per RFC 7807 §3.2. */
  readonly [key: string]: unknown;
}

/**
 * Optional inputs accepted by `createProblem` and `ProblemError`. All but
 * `status` and `code` are optional; missing values are derived from defaults
 * (status text for `title`, problem code path for `type`).
 */
export interface ProblemOptions {
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable problem code. */
  readonly code: string;
  /** Optional override for the problem-class URI. */
  readonly type?: string;
  /** Optional override for the short human-readable title. */
  readonly title?: string;
  /** Optional human-readable detail. */
  readonly detail?: string;
  /** Optional pre-resolved `request_id`. */
  readonly request_id?: string;
  /** Optional extension members merged into the body. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}
