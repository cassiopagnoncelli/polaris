import { z } from "zod";

/**
 * Closed set of machine-readable reason codes the ingester returns inside
 * per-event batch responses for schema-related rejections. These codes are
 * declared here so consumers (ingester implementation, SDKs, CLI, tests)
 * share one source of truth.
 *
 * The forbidden-field policy's reason codes (`pii_card`, `pii_account`,
 * `pii_secret`, `policy`, `length`, `pattern_match`) live alongside the
 * policy module (P0-009) and are not duplicated here.
 *
 * Emission of these codes lands with the ingester batch validation work
 * in P2-003; this package provides the shape so other components can
 * build against it now.
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
 * Shape of a per-event rejection entry inside a batch response. The
 * ingester returns these alongside the rejected event_id so producers
 * can react without re-parsing free-form error strings.
 *
 * Only the shape is defined here; ingester emission lands in P2-003.
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
