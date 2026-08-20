/**
 * OpenAPI 3.0 component schemas derived from the canonical Zod sources.
 *
 * Polaris keeps a single source of truth for envelope/batch shapes (the Zod
 * schemas in `@polaris/shared-schemas`). The OpenAPI document is *derived*
 * from those Zod schemas via `z.toJSONSchema(..., { target: "openapi-3.0" })`
 * — adding a hand-written OpenAPI shape next to the Zod one would drift the
 * moment a schema changed. See `docs/architecture/09-engineering-standards.md`
 * "OpenAPI".
 *
 * The component map exported here is what ends up under
 * `#/components/schemas` in the published OpenAPI document. Routes in
 * `./paths.ts` reference these by name.
 */

import {
  batchAcceptedResultSchema,
  batchReasonCodeSchema,
  batchRejectedResultSchema,
  batchResponseSchema,
  envelopeSchema,
  producerEnvelopeSchema,
  schemaReasonCodeSchema,
} from "@polaris/shared-schemas";
import { z } from "zod";

import { batchRequestSchema } from "../ingest/types.js";

/**
 * Result of converting a Zod schema to an OpenAPI 3.0 Schema Object. We
 * keep the type loose (`Record<string, unknown>`) because OpenAPI Schema
 * Object is an open object and the YAML/JSON serializers pass through any
 * keys we attach. Tests inspect the converted shape via property reads.
 */
export type OpenApiSchemaObject = Record<string, unknown>;

/**
 * Convert a Zod schema to an OpenAPI 3.0 Schema Object.
 *
 * Polaris targets OpenAPI 3.0 (not 3.1) because tooling support is broader
 * — most of the dashboards we'd render the doc with (Redocly, Swagger UI,
 * Stoplight) accept 3.0 cleanly. Zod v4's `toJSONSchema` includes a
 * dedicated `"openapi-3.0"` target that emits 3.0-compatible output
 * (notably: `nullable: true` instead of `["string", "null"]` type unions).
 */
function fromZod(schema: z.ZodTypeAny): OpenApiSchemaObject {
  return z.toJSONSchema(schema, { target: "openapi-3.0" }) as OpenApiSchemaObject;
}

/**
 * Polaris-specific add-ons that don't live in the Zod source:
 *   - human-readable `description` for the component (the Zod schemas have
 *     no description metadata in the current source tree; the OpenAPI doc
 *     is the natural place for it)
 *   - `example` payloads so Redocly / Swagger UI render usable examples
 */
function annotate(
  schema: OpenApiSchemaObject,
  annotation: {
    readonly description?: string;
    readonly example?: unknown;
    readonly examples?: Record<string, { readonly summary?: string; readonly value: unknown }>;
  },
): OpenApiSchemaObject {
  const out: OpenApiSchemaObject = { ...schema };
  if (annotation.description !== undefined) out["description"] = annotation.description;
  if (annotation.example !== undefined) out["example"] = annotation.example;
  if (annotation.examples !== undefined) out["examples"] = annotation.examples;
  return out;
}

/**
 * Example canonical envelope reused across components and paths.
 *
 * Kept consistent with `docs/architecture/01-event-contract.md` "Canonical
 * Envelope" so the published doc matches the architecture reference.
 */
export const EXAMPLE_CANONICAL_ENVELOPE = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  event: "payment.approved",
  schema_version: 1,
  project_id: "checkout",
  environment: "production",
  occurred_at: "2026-05-11T12:00:00.000Z",
  ingested_at: "2026-05-11T12:00:01.120Z",
  source: {
    type: "backend",
    id: "payments-api",
    sdk: "node",
    sdk_version: "1.0.0",
  },
  identity: {
    anonymous_id: null,
    session_id: null,
    customer_id: "cus_123",
    device_id: null,
  },
  context: {
    ip: "203.0.113.10",
    user_agent: "Mozilla/5.0 ...",
    locale: "pt-BR",
    page: null,
    campaign: null,
  },
  properties: {
    payment_id: "pay_123",
    order_id: "ord_456",
    amount: 12990,
    currency: "BRL",
  },
} as const;

const EXAMPLE_PRODUCER_ENVELOPE = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  event: "page.viewed",
  schema_version: 2,
  occurred_at: "2026-05-11T12:00:00.000Z",
  source: { type: "browser", sdk: "web", sdk_version: "1.0.0" },
  identity: {
    anonymous_id: "anon_018f...",
    session_id: "sess_018f...",
    customer_id: null,
    device_id: null,
  },
  context: {
    ip: null,
    user_agent: "Mozilla/5.0 ...",
    locale: "pt-BR",
    page: { url: "https://shop.example/cart", path: "/cart", title: "Cart", referrer: null },
    campaign: null,
  },
  properties: { path: "/cart", title: "Cart" },
} as const;

const EXAMPLE_BATCH_REQUEST = {
  events: [EXAMPLE_PRODUCER_ENVELOPE],
} as const;

const EXAMPLE_BATCH_RESPONSE_FULL_ACCEPT = {
  accepted: [
    { event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551", status: "accepted" },
    {
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
      status: "accepted",
      deprecated: true,
    },
  ],
  rejected: [],
} as const;

const EXAMPLE_BATCH_RESPONSE_PARTIAL = {
  accepted: [{ event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551", status: "accepted" }],
  rejected: [
    {
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
      status: "rejected",
      code: "schema_validation_failed",
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
        message: "forbidden field 'properties.cvv' present (policy reason: pii_card)",
      },
    },
    {
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f554",
      status: "rejected",
      code: "duplicate",
      detail: {
        event: "page.viewed",
        message: "event_id observed within the ingester dedupe window",
      },
    },
  ],
} as const;

/**
 * RFC 7807 Problem Details body shape returned for request-level failures.
 *
 * Mirrors `libs/runtime/service-bootstrap/src/problem/types.ts`. The
 * Problem body is intentionally open (RFC 7807 §3.2 extension members) so
 * we describe required core fields and leave room for extensions via
 * `additionalProperties: true`.
 */
const problemBodySchema: OpenApiSchemaObject = {
  type: "object",
  title: "ProblemBody",
  description:
    "RFC 7807 Problem Details body returned for request-level failures. Per Polaris convention, `code` and `request_id` are always present so SDK retry logic and operators can correlate the failure deterministically.",
  required: ["type", "title", "status", "code", "request_id"],
  properties: {
    type: {
      type: "string",
      format: "uri",
      description: "Fully qualified URI identifying the problem class.",
      example: "https://docs.polaris/errors/invalid_api_key",
    },
    title: {
      type: "string",
      description: "Short, human-readable summary of the problem class.",
      example: "Invalid API key",
    },
    status: {
      type: "integer",
      minimum: 400,
      maximum: 599,
      description: "HTTP status code, mirrored into the body so log readers see it.",
      example: 401,
    },
    code: {
      type: "string",
      description:
        "Stable machine-readable problem code. SDKs branch on this — see the per-response examples below.",
      example: "invalid_api_key",
    },
    detail: {
      type: "string",
      description: "Optional human-readable detail; safe for end-user display.",
      example: "The provided API key is invalid or revoked.",
    },
    request_id: {
      type: "string",
      format: "uuid",
      description: "Per-request UUIDv7 correlation ID — also echoed in `x-request-id`.",
      example: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    },
  },
  additionalProperties: true,
};

/**
 * Build the `#/components/schemas` map.
 *
 * Each entry is the Zod schema converted to an OpenAPI 3.0 Schema Object,
 * with a description and example added. Building the map at runtime keeps
 * a single source of truth: if a Zod schema changes, the OpenAPI shape
 * changes the next time the generator runs.
 */
export function buildComponentSchemas(): Record<string, OpenApiSchemaObject> {
  return {
    Envelope: annotate(fromZod(envelopeSchema), {
      description:
        "Canonical event envelope. The ingester stamps `project_id`, `environment`, `ingested_at`, and trusted `source.id` from the API key; this is the *post-stamp* shape downstream consumers see in RabbitMQ `raw.events`.",
      example: EXAMPLE_CANONICAL_ENVELOPE,
    }),
    ProducerEnvelope: annotate(fromZod(producerEnvelopeSchema), {
      description:
        "Producer-side envelope: the shape SDKs and trusted producers actually send. The ingester overwrites `project_id`, `environment`, `ingested_at`, and `source.id` from the API key, so producers omit them.",
      example: EXAMPLE_PRODUCER_ENVELOPE,
    }),
    BatchRequest: annotate(fromZod(batchRequestSchema), {
      description:
        "Request body for `POST /v1/events`. Producers send a batch of `ProducerEnvelope` entries; per-event validation, partial acceptance, and per-event reason codes are described in the `BatchResponse` shape.",
      example: EXAMPLE_BATCH_REQUEST,
    }),
    BatchAcceptedResult: annotate(fromZod(batchAcceptedResultSchema), {
      description:
        "Per-event entry in the `accepted` array of a `BatchResponse`. `deprecated: true` is present when the event used a deprecated `schema_version` still inside its sunset window.",
    }),
    BatchRejectedResult: annotate(fromZod(batchRejectedResultSchema), {
      description:
        "Per-event entry in the `rejected` array of a `BatchResponse`. `code` is one of the stable reason codes in `BatchReasonCode`. `detail.path` carries field paths but never the rejected or redacted value.",
    }),
    BatchResponse: annotate(fromZod(batchResponseSchema), {
      description:
        "Response body for `POST /v1/events`. Partial acceptance is non-negotiable: both `accepted` and `rejected` may be non-empty in the same response.",
      examples: {
        fullAccept: { summary: "All events accepted", value: EXAMPLE_BATCH_RESPONSE_FULL_ACCEPT },
        partialAccept: {
          summary: "Some events rejected (partial acceptance)",
          value: EXAMPLE_BATCH_RESPONSE_PARTIAL,
        },
      },
    }),
    BatchReasonCode: annotate(fromZod(batchReasonCodeSchema), {
      description:
        "Closed set of stable machine-readable reason codes the ingester emits inside `BatchRejectedResult.code`. SDK retry logic and dashboards branch on these literals. Schema-related codes (`unsupported_schema_version`, `schema_version_sunset`, ...) overlap with `SchemaReasonCode`.",
    }),
    SchemaReasonCode: annotate(fromZod(schemaReasonCodeSchema), {
      description:
        "Subset of `BatchReasonCode` produced by the catalog validator (envelope and per-event property validation). Kept as its own component because processors and consumers reuse it to label DLQ entries.",
    }),
    ProblemBody: problemBodySchema,
  };
}
