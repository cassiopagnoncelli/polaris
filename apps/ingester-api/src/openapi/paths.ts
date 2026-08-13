/**
 * OpenAPI `paths` object for the Polaris ingester.
 *
 * The ingester is the only HTTP service in v1, so this module covers:
 *   - `POST /v1/events` — the ingest entry point
 *   - `GET  /health`    — liveness
 *   - `GET  /ready`     — readiness (with probes)
 *   - `GET  /metrics`   — Prometheus exposition
 *
 * Future services (control-plane API, dashboard API) ship their own
 * `openapi` package; we deliberately do not try to host their paths here.
 *
 * Error responses point at the shared `ProblemBody` component and include
 * concrete examples per stable Problem `code` so SDK retry logic can be
 * driven from the doc alone.
 */

import { API_KEY_HEADER } from "../auth/api-key.js";

import { EXAMPLE_CANONICAL_ENVELOPE } from "./schemas.js";

type PathItem = Record<string, unknown>;

/**
 * `POST /v1/events` Problem responses. Each entry corresponds to a stable
 * Problem `code` documented in either:
 *
 *   - `packages/shared-service-bootstrap/src/problem/types.ts` (common
 *     codes such as `invalid_request`, `payload_too_large`)
 *   - `apps/ingester-api/src/auth/errors.ts` (`missing_api_key`,
 *     `invalid_api_key`, `auth_unavailable`)
 *
 * Listing them in the OpenAPI doc means SDKs only need to read the doc to
 * implement retry behaviour.
 */
const PROBLEM_RESPONSES = {
  "400": {
    description:
      "The request body is malformed — either invalid JSON or the batch envelope does not match `BatchRequest`. Per-event validation failures use the per-event `BatchRejectedResult` codes inside a 200 response, not a 400 Problem.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemBody" },
        examples: {
          invalidRequest: {
            summary: "Invalid request body",
            value: {
              type: "https://docs.polaris/errors/invalid_request",
              title: "Invalid request",
              status: 400,
              code: "invalid_request",
              detail: "request body is not a valid event batch",
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            },
          },
        },
      },
    },
  },
  "401": {
    description:
      "Authentication failed. Polaris maps every reject reason (malformed header, no matching `api_key_id`, revoked row, hash mismatch, algorithm mismatch) to the same `invalid_api_key` code so attackers cannot enumerate which arm failed. A missing header maps to `missing_api_key`.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemBody" },
        examples: {
          missingApiKey: {
            summary: "No API key header sent",
            value: {
              type: "https://docs.polaris/errors/missing_api_key",
              title: "Missing API key",
              status: 401,
              code: "missing_api_key",
              detail: `Missing required \`${API_KEY_HEADER}\` header.`,
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            },
          },
          invalidApiKey: {
            summary: "API key invalid or revoked",
            value: {
              type: "https://docs.polaris/errors/invalid_api_key",
              title: "Invalid API key",
              status: 401,
              code: "invalid_api_key",
              detail: "The provided API key is invalid or revoked.",
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
            },
          },
        },
      },
    },
  },
  "403": {
    description:
      "The request `Origin` header is not on the per-source CORS allow-list. Browsers see the standard CORS error path (no `Access-Control-Allow-Origin` response header) and refuse the request; server-to-server callers (no `Origin` header) bypass the check. Operators manage the allow-list through the `source_allowed_origins` table.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemBody" },
        examples: {
          originNotAllowed: {
            summary: "Cross-origin browser request from a disallowed origin",
            value: {
              type: "https://docs.polaris/errors/origin_not_allowed",
              title: "Origin not allowed",
              status: 403,
              code: "origin_not_allowed",
              detail:
                "The request `Origin` header is not on the per-source allow-list. Check the source's allowed origins in the control plane.",
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            },
          },
        },
      },
    },
  },
  "413": {
    description:
      "The batch exceeded the configured per-request event count or body size. The body limit is enforced by Fastify (see `config.http.bodyLimitBytes`); the per-batch event cap is enforced by the ingest handler. SDKs must split the batch and retry.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemBody" },
        examples: {
          payloadTooLarge: {
            summary: "Body exceeds bodyLimitBytes",
            value: {
              type: "https://docs.polaris/errors/payload_too_large",
              title: "Payload too large",
              status: 413,
              code: "payload_too_large",
              detail: "Request body exceeds the configured limit.",
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            },
          },
          batchTooLarge: {
            summary: "Batch exceeds the per-request event cap (in a 200 envelope error)",
            value: {
              accepted: [],
              rejected: [],
              error: {
                code: "invalid_request",
                message: "batch exceeds the maximum of 1000 events",
              },
            },
          },
        },
      },
    },
  },
  "415": {
    description:
      "The request `content-type` is not `application/json`. SDKs always send JSON; this only surfaces against hand-rolled producers.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemBody" },
        examples: {
          unsupportedMediaType: {
            summary: "Wrong content-type",
            value: {
              type: "https://docs.polaris/errors/unsupported_media_type",
              title: "Unsupported media type",
              status: 415,
              code: "unsupported_media_type",
              detail: "Expected application/json.",
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            },
          },
        },
      },
    },
  },
  "429": {
    description:
      "The per-API-key rate limit has been exceeded for the current window. The response carries a `Retry-After` header in seconds; SDKs MUST back off for at least that long before the next attempt. Refusals increment `polaris_ingest_rate_limit_rejected_total`. Polaris fails OPEN if the limiter subsystem (Redis) is unavailable — see `polaris_ingest_rate_limit_skipped_total`. Operators tune the per-key budget via `POLARIS_RATE_LIMIT_PER_API_KEY_RPS`, and set a per-project budget with `polaris config set --namespace ingest --key rate_limit_rps`.",
    headers: {
      "Retry-After": {
        description:
          "Number of seconds the SDK MUST wait before retrying. Always present on a 429 response.",
        schema: { type: "integer", minimum: 1 },
        example: 7,
      },
    },
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemBody" },
        examples: {
          rateLimited: {
            summary: "Per-API-key rate limit exceeded",
            value: {
              type: "https://docs.polaris/errors/rate_limited",
              title: "Too many requests",
              status: 429,
              code: "rate_limited",
              detail: "Per-key rate limit exceeded. Retry after 7s.",
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            },
          },
        },
      },
    },
  },
  "500": {
    description:
      "Unhandled server-side error. Stable `code` is `internal_error`; SDKs treat this as transient and retry with backoff.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemBody" },
        examples: {
          internalError: {
            summary: "Unhandled server error",
            value: {
              type: "https://docs.polaris/errors/internal_error",
              title: "Internal error",
              status: 500,
              code: "internal_error",
              detail: "An unexpected error occurred.",
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            },
          },
        },
      },
    },
  },
  "503": {
    description:
      "Auth dependency unavailable (PostgreSQL outage). SDKs retry with backoff. Surfaced as 503 rather than 401 so producers do not invalidate working keys on a transient outage.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemBody" },
        examples: {
          authUnavailable: {
            summary: "Auth dependency down",
            value: {
              type: "https://docs.polaris/errors/auth_unavailable",
              title: "Authentication unavailable",
              status: 503,
              code: "auth_unavailable",
              detail: "Authentication backend is temporarily unavailable.",
              request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
            },
          },
        },
      },
    },
  },
} as const;

const EVENTS_POST: PathItem = {
  post: {
    operationId: "ingestEvents",
    summary: "Ingest a batch of events",
    description:
      "Authenticates the API key, validates each event independently against the canonical envelope and registered `schema_version`, applies the forbidden-field policy (reject vs redact), performs short-window dedupe, and publishes accepted events to RabbitMQ `raw.events`. Partial acceptance is non-negotiable: one invalid event does not block the rest of the batch — see the `partialAccept` example below.\n\nSee [Ingestion and SDKs](https://github.com/polaris/polaris/blob/main/docs/architecture/04-ingestion-and-sdks.md) for the architectural contract and [SDK handbook](https://github.com/polaris/polaris/blob/main/docs/sdk/README.md) for the client-side perspective.",
    tags: ["ingest"],
    security: [{ apiKey: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/BatchRequest" },
          examples: {
            singleEvent: {
              summary: "Single producer event",
              value: { events: [EXAMPLE_CANONICAL_ENVELOPE] },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description:
          "Batch processed. Both `accepted` and `rejected` may be non-empty in the same response. SDKs MUST NOT retry permanently invalid events (see `BatchReasonCode`); transient failures (`publish_failed`) may be retried with backoff.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BatchResponse" },
            examples: {
              fullAccept: {
                summary: "All events accepted",
                value: {
                  accepted: [
                    {
                      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
                      status: "accepted",
                    },
                  ],
                  rejected: [],
                },
              },
              partialAccept: {
                summary: "Partial acceptance (mix of accepted + rejected)",
                value: {
                  accepted: [
                    {
                      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
                      status: "accepted",
                    },
                  ],
                  rejected: [
                    {
                      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
                      status: "rejected",
                      code: "invalid_properties",
                      detail: {
                        event: "payment.approved",
                        schema_version: 1,
                        path: ["amount"],
                        message: "Number must be positive",
                      },
                    },
                    {
                      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f553",
                      status: "rejected",
                      code: "forbidden_field_rejected",
                      detail: {
                        path: ["properties", "cvv"],
                        policy_reason: "pii_card",
                        message:
                          "forbidden field 'properties.cvv' present (policy reason: pii_card)",
                      },
                    },
                    {
                      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f554",
                      status: "rejected",
                      code: "publish_failed",
                      detail: {
                        event: "page.viewed",
                        message: "raw.events publish failed; retry the event",
                      },
                    },
                  ],
                },
              },
              malformedBatch: {
                summary:
                  "Batch envelope itself is malformed (status 400; shown here for body shape)",
                value: {
                  accepted: [],
                  rejected: [],
                  error: {
                    code: "invalid_request",
                    message: "request body is not a valid event batch",
                  },
                },
              },
            },
          },
        },
      },
      "400": PROBLEM_RESPONSES["400"],
      "401": PROBLEM_RESPONSES["401"],
      "403": PROBLEM_RESPONSES["403"],
      "413": PROBLEM_RESPONSES["413"],
      "415": PROBLEM_RESPONSES["415"],
      "429": PROBLEM_RESPONSES["429"],
      "500": PROBLEM_RESPONSES["500"],
      "503": PROBLEM_RESPONSES["503"],
    },
  },
};

const HEALTH_GET: PathItem = {
  get: {
    operationId: "getHealth",
    summary: "Liveness probe",
    description:
      "Answers 200 as long as the process is up. Use for container liveness probes — `/health` does NOT check downstream dependencies. For dependency status use `/ready`.",
    tags: ["operations"],
    responses: {
      "200": {
        description: "Service process is alive.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                status: { type: "string", example: "ok" },
                service: { type: "string", example: "ingester-api" },
                version: { type: "string", example: "0.0.1" },
                git_sha: { type: "string", example: "deadbee" },
                build_time: { type: "string", format: "date-time" },
                environment: { type: "string", example: "production" },
                time: { type: "string", format: "date-time" },
              },
              required: ["status", "service", "version", "time"],
            },
          },
        },
      },
    },
  },
};

const READY_GET: PathItem = {
  get: {
    operationId: "getReady",
    summary: "Readiness probe",
    description:
      "Aggregates registered readiness probes (PostgreSQL, Redis, RabbitMQ, ...). Returns 200 when every probe reports `up`; returns 503 when any probe is `down` (or `degraded`, by default). Use for container readiness / Kubernetes readiness checks.",
    tags: ["operations"],
    responses: {
      "200": {
        description: "All probes report `up`.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReadinessResponse" },
          },
        },
      },
      "503": {
        description: "One or more probes reported `down` or `degraded`.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReadinessResponse" },
          },
        },
      },
    },
  },
};

const METRICS_GET: PathItem = {
  get: {
    operationId: "getMetrics",
    summary: "Prometheus metrics exposition",
    description:
      "Returns Prometheus text-format metrics. Scraped by Prometheus; not intended for direct consumption by SDKs.",
    tags: ["operations"],
    responses: {
      "200": {
        description: "Prometheus text exposition.",
        content: {
          "text/plain; version=0.0.4; charset=utf-8": {
            schema: { type: "string" },
            example:
              '# HELP polaris_ingest_batch_accepted_total Accepted ingester events.\n# TYPE polaris_ingest_batch_accepted_total counter\npolaris_ingest_batch_accepted_total{project_id="checkout",environment="production"} 12345\n',
          },
        },
      },
    },
  },
};

/**
 * Extra schemas referenced only by the operations paths (not by `/v1/events`).
 * Kept here rather than in `schemas.ts` so the Zod-derived components in
 * that module stay 1:1 with the canonical event contract.
 */
export const OPERATIONS_COMPONENT_SCHEMAS: Record<string, Record<string, unknown>> = {
  ReadinessResponse: {
    type: "object",
    description: "Body returned by `/ready`. Per-probe results are surfaced individually.",
    required: ["status", "service", "version", "time", "probes"],
    properties: {
      status: { type: "string", enum: ["ready", "not_ready"] },
      service: { type: "string", example: "ingester-api" },
      version: { type: "string", example: "0.0.1" },
      time: { type: "string", format: "date-time" },
      probes: {
        type: "array",
        items: { $ref: "#/components/schemas/ReadinessProbeResult" },
      },
    },
  },
  ReadinessProbeResult: {
    type: "object",
    required: ["name", "status"],
    properties: {
      name: { type: "string", example: "postgres" },
      status: { type: "string", enum: ["up", "down", "degraded"] },
      detail: { type: "string" },
      latencyMs: { type: "number" },
    },
  },
};

export function buildPaths(): Record<string, PathItem> {
  return {
    "/v1/events": EVENTS_POST,
    "/health": HEALTH_GET,
    "/ready": READY_GET,
    "/metrics": METRICS_GET,
  };
}
