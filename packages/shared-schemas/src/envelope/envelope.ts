import { z } from "zod";
import {
  consentSchema,
  contextSchema,
  environmentSchema,
  eventNameSchema,
  identitySchema,
  isoUtcTimestampSchema,
  privacySchema,
  schemaVersionSchema,
  sourceSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Canonical envelope (platform-owned).
 *
 * Per `docs/architecture/01-event-contract.md`:
 *   - The top-level envelope is rigid and rejects unknown fields.
 *   - `project_id`, `environment`, `ingested_at`, and trusted `source.id`
 *     are stamped by the ingester from the API key, not accepted from
 *     producers. Validation here intentionally accepts both shapes so
 *     this schema can validate both producer payloads (pre-stamp) and
 *     fully-stamped canonical events (post-stamp).
 *   - `consent` and `privacy` are informational metadata.
 *   - `properties` is event-owner-defined and validated separately by
 *     per-event Zod schemas from the catalog.
 *
 * Property validation against the declared `schema_version` is performed
 * by combining this envelope with the matching catalog entry — see
 * `src/catalog/loader.ts`.
 */
export const envelopeSchema = z
  .object({
    event_id: uuidSchema,
    event: eventNameSchema,
    schema_version: schemaVersionSchema,
    project_id: z.string().min(1).max(128),
    environment: environmentSchema,
    occurred_at: isoUtcTimestampSchema,
    ingested_at: isoUtcTimestampSchema,
    source: sourceSchema,
    identity: identitySchema,
    context: contextSchema,
    properties: z.record(z.string(), z.unknown()),
    consent: consentSchema.optional(),
    privacy: privacySchema.optional(),
  })
  .strict();

/**
 * Producer-side envelope: the same shape the SDKs/producers actually
 * send. The ingester stamps `project_id`, `environment`, `ingested_at`,
 * and trusted `source.id` afterwards, so producers may omit them.
 *
 * Even at the producer boundary, unknown top-level fields are rejected.
 */
export const producerEnvelopeSchema = z
  .object({
    event_id: uuidSchema,
    event: eventNameSchema,
    schema_version: schemaVersionSchema,
    occurred_at: isoUtcTimestampSchema,
    source: sourceSchema.partial({ id: true }),
    identity: identitySchema,
    context: contextSchema,
    properties: z.record(z.string(), z.unknown()),
    consent: consentSchema.optional(),
    privacy: privacySchema.optional(),
  })
  .strict();

export type Envelope = z.infer<typeof envelopeSchema>;
export type ProducerEnvelope = z.infer<typeof producerEnvelopeSchema>;
