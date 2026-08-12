import { z } from "zod";

/**
 * Closed set of machine-readable reason codes the ingester returns inside
 * per-event batch responses. The set is the **only** vocabulary the
 * ingester's batch responses emit; SDKs, the CLI, processors, and tests
 * all branch off these literals.
 *
 * Two sub-families:
 *
 *   - schema-related (`schemaReasonCodeSchema`): produced by the catalog
 *     validator
 *   - batch-flow (`batchReasonCodeSchema`): produced by the ingester
 *     orchestrator (forbidden-field policy, dedupe, publish, ingest-side
 *     wire problems)
 *
 * The forbidden-field policy's per-rule reason codes (`pii_card`,
 * `pii_account`, `pii_secret`, `policy`, `length`, `pattern_match`) live
 * alongside the policy module (P0-009) and are not duplicated here — they
 * describe **why** a field was matched, not the batch-response code that
 * surfaces the match.
 */

/** Producer sent a `schema_version` that the catalog does not know about. */
export const SCHEMA_REASON_UNSUPPORTED_VERSION = "unsupported_schema_version";

/** Producer sent a `schema_version` that is registered but has been sunset. */
export const SCHEMA_REASON_SUNSET = "schema_version_sunset";

/** Producer sent an event name that is not registered in the catalog. */
export const SCHEMA_REASON_UNKNOWN_EVENT = "unknown_event";

/** Properties failed validation against the declared `schema_version`. */
export const SCHEMA_REASON_INVALID_PROPERTIES = "invalid_properties";

/** Top-level envelope failed validation (e.g. unknown top-level field). */
export const SCHEMA_REASON_INVALID_ENVELOPE = "invalid_envelope";

export const schemaReasonCodeSchema = z.enum([
  SCHEMA_REASON_UNSUPPORTED_VERSION,
  SCHEMA_REASON_SUNSET,
  SCHEMA_REASON_UNKNOWN_EVENT,
  SCHEMA_REASON_INVALID_PROPERTIES,
  SCHEMA_REASON_INVALID_ENVELOPE,
]);

export type SchemaReasonCode = z.infer<typeof schemaReasonCodeSchema>;

/**
 * Reason returned when an event is rejected because the forbidden-field
 * policy's reject tier fired. The per-rule reason code (`pii_card`,
 * `pii_secret`, ...) lives on the response detail so producers can fix
 * the underlying field; the top-level code is intentionally stable across
 * rule additions.
 */
export const BATCH_REASON_FORBIDDEN_FIELD_REJECTED = "forbidden_field_rejected";

/**
 * Reason returned when a duplicate `event_id` was observed inside the
 * ingester's short-window dedupe (15-min default, up to 24h opt-in). The
 * downstream pipeline remains the canonical idempotency layer; this code
 * exists so producers can recognise the dedupe-at-edge effect without
 * conflating it with permanent rejection.
 */
export const BATCH_REASON_DUPLICATE = "duplicate";

/**
 * Reason returned when an accepted event cannot be published to RabbitMQ
 * (transient broker failure, serializer error). SDKs retry these with
 * backoff; the event is **not** counted as accepted by the ingester.
 */
export const BATCH_REASON_PUBLISH_FAILED = "publish_failed";

/**
 * Reason returned when another request holds an unresolved dedupe lease on
 * the same `event_id` — the first attempt is mid-publish, or its process died
 * before it could resolve.
 *
 * Distinct from `duplicate` on purpose, and the distinction is the whole
 * point: `duplicate` asserts the platform HAS the event, so a producer that
 * believes it can stop retrying is right. During a lease that assertion is not
 * yet true. Answering `duplicate` there is how the pre-lease implementation
 * turned a broker blip into permanent loss — the client was told the event was
 * safely stored when it had never been published at all.
 *
 * Retryable, with backoff. The lease is short (see `DEDUPE_LEASE_TTL_SEC`), so
 * a retry either finds the event confirmed (`duplicate`, genuinely) or an
 * expired lease it may claim itself.
 */
export const BATCH_REASON_IN_PROGRESS = "in_progress";

/**
 * Reason returned when the request payload at the batch level is itself
 * malformed (e.g. `events` is missing or not an array). Used for the small
 * envelope around the batch — not for per-event envelope/property errors.
 */
export const BATCH_REASON_INVALID_REQUEST = "invalid_request";

/**
 * Closed superset of every per-event reason code the ingester emits.
 *
 * Schema-related codes are reused verbatim; the union below adds the
 * batch-flow codes (policy reject, dedupe hit, publish failure, malformed
 * per-event payload that came in below the schema layer).
 */
export const batchReasonCodeSchema = z.enum([
  BATCH_REASON_IN_PROGRESS,
  SCHEMA_REASON_UNSUPPORTED_VERSION,
  SCHEMA_REASON_SUNSET,
  SCHEMA_REASON_UNKNOWN_EVENT,
  SCHEMA_REASON_INVALID_PROPERTIES,
  SCHEMA_REASON_INVALID_ENVELOPE,
  BATCH_REASON_FORBIDDEN_FIELD_REJECTED,
  BATCH_REASON_DUPLICATE,
  BATCH_REASON_PUBLISH_FAILED,
  BATCH_REASON_INVALID_REQUEST,
]);

export type BatchReasonCode = z.infer<typeof batchReasonCodeSchema>;

/**
 * Shape of a per-event rejection entry inside a batch response. The
 * ingester returns these alongside the rejected event_id so producers
 * can react without re-parsing free-form error strings.
 */
export const schemaRejectionSchema = z
  .object({
    event_id: z.string().uuid(),
    code: schemaReasonCodeSchema,
    /** Optional structured detail; values never include redacted content. */
    detail: z
      .object({
        event: z.string().optional(),
        schema_version: z.number().int().optional(),
        sunset_at: z.string().datetime({ offset: false }).optional(),
        supported_versions: z.array(z.number().int()).optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
        message: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SchemaRejection = z.infer<typeof schemaRejectionSchema>;

/**
 * Per-event accepted entry inside a batch response. Lightweight: producers
 * primarily care about the event_id so they can mark their queue entry as
 * delivered.
 */
export const batchAcceptedResultSchema = z
  .object({
    event_id: z.string().uuid(),
    status: z.literal("accepted"),
    /**
     * True when the event was accepted but uses a deprecated `schema_version`
     * still inside its sunset window. Producers should use this to surface
     * a deprecation warning in their own logs.
     */
    deprecated: z.boolean().optional(),
  })
  .strict();

export type BatchAcceptedResult = z.infer<typeof batchAcceptedResultSchema>;

/**
 * Per-event rejection entry inside the batch response. The shape covers
 * every reason in `batchReasonCodeSchema`. The `detail.path` field carries
 * **field paths only** — never the rejected/redacted field value.
 */
export const batchRejectedResultSchema = z
  .object({
    event_id: z.string().uuid(),
    status: z.literal("rejected"),
    code: batchReasonCodeSchema,
    detail: z
      .object({
        event: z.string().optional(),
        schema_version: z.number().int().optional(),
        sunset_at: z.string().datetime({ offset: false }).optional(),
        supported_versions: z.array(z.number().int()).optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
        message: z.string().optional(),
        /** Closed-set policy reason (only present for `forbidden_field_rejected`). */
        policy_reason: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type BatchRejectedResult = z.infer<typeof batchRejectedResultSchema>;

/**
 * Top-level shape of `POST /v1/events` batch responses. Partial acceptance
 * means both lists may be non-empty in the same response.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md "Batch Failure Behavior"
 */
export const batchResponseSchema = z
  .object({
    accepted: z.array(batchAcceptedResultSchema),
    rejected: z.array(batchRejectedResultSchema),
  })
  .strict();

export type BatchResponse = z.infer<typeof batchResponseSchema>;
