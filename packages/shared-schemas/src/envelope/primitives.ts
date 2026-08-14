import { polarisEnvironmentSchema } from "@polaris/shared-environments";
import { z } from "zod";

/**
 * Shared envelope primitives used by the canonical envelope schema and by
 * downstream consumers that need to reuse the same shapes (e.g. event
 * batch responses).
 *
 * All schemas use `.strict()` where they describe top-level platform-owned
 * structures so that unknown fields are rejected (per
 * `docs/architecture/01-event-contract.md`). Nested `properties` is treated
 * as event-owner discretion and validated separately.
 */

/** UUIDv7 (or any RFC 4122 UUID-shaped string). */
export const uuidSchema = z
  .string()
  .uuid({ message: "must be a UUID (UUIDv7 recommended for platform IDs)" });

/**
 * Event name rules (per spec):
 *   - lowercase ASCII
 *   - dot-separated
 *   - each segment is snake_case
 *   - at least two segments
 *
 * The platform also reserves the `experimental.*` and `polaris.*`
 * namespaces; downstream code may inspect the parsed name.
 */
export const eventNameRegex = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export const eventNameSchema = z.string().min(1).max(128).regex(eventNameRegex, {
  message:
    "event name must be lowercase snake_case segments joined by dots, with at least two segments",
});

/** ISO 8601 UTC timestamp string. */
export const isoUtcTimestampSchema = z
  .string()
  .datetime({ offset: false, message: "must be an ISO 8601 UTC timestamp" });

/** Environment is stamped by the ingester from the API key; producers do not supply it. */
export const environmentSchema = polarisEnvironmentSchema;

/** schema_version is a per-event positive integer. */
export const schemaVersionSchema = z
  .number()
  .int({ message: "schema_version must be an integer" })
  .positive({ message: "schema_version must be >= 1" });

/** Source metadata describing the producer. */
export const sourceSchema = z
  .object({
    type: z.enum(["browser", "backend", "mobile", "server", "internal"]),
    id: z.string().min(1).max(128),
    sdk: z.string().min(1).max(64).nullish(),
    sdk_version: z.string().min(1).max(64).nullish(),
  })
  .strict();

/** Identity layer — all fields nullable; values present only when known. */
export const identitySchema = z
  .object({
    anonymous_id: z.string().min(1).max(128).nullable(),
    session_id: z.string().min(1).max(128).nullable(),
    customer_id: z.string().min(1).max(128).nullable(),
    device_id: z.string().min(1).max(128).nullable(),
  })
  .strict();

/** Page sub-context (only present for browser sources, but optional everywhere). */
export const pageContextSchema = z
  .object({
    url: z.string().url().max(2048).nullish(),
    path: z.string().max(2048).nullish(),
    title: z.string().max(512).nullish(),
    referrer: z.string().max(2048).nullish(),
  })
  .strict();

/** Campaign sub-context. */
export const campaignContextSchema = z
  .object({
    source: z.string().max(128).nullish(),
    medium: z.string().max(128).nullish(),
    name: z.string().max(256).nullish(),
    term: z.string().max(256).nullish(),
    content: z.string().max(256).nullish(),
    click_id: z.string().max(256).nullish(),
  })
  .strict();

/** Context section — every nested field nullable. */
export const contextSchema = z
  .object({
    ip: z.string().max(64).nullable(),
    user_agent: z.string().max(1024).nullable(),
    locale: z.string().max(32).nullable(),
    page: pageContextSchema.nullable(),
    campaign: campaignContextSchema.nullable(),
  })
  .strict();

/** Informational consent metadata (not enforced in v1). */
export const consentSchema = z
  .object({
    analytics: z.boolean().nullish(),
    marketing: z.boolean().nullish(),
    personalization: z.boolean().nullish(),
  })
  .strict();

/** Informational privacy metadata (not enforced in v1). */
export const privacySchema = z
  .object({
    classification: z.enum(["public", "internal", "confidential", "restricted"]).nullish(),
  })
  .strict();

// ---------------------------------------------------------------------
// Platform-owned resolution blocks (`profile`, `enrichment`).
//
// These carry what POLARIS derived about an event, as opposed to
// `identity`/`context`, which carry what the PRODUCER observed. It is the
// same split `occurred_at` vs `ingested_at` makes: two writers, two
// meanings, never merged into one field.
//
// Producers cannot forge either block. `producerEnvelopeSchema` simply does
// not list them and is `.strict()`, so an attempt is rejected as
// `invalid_envelope` with no extra validation code.
//
// Both blocks are filled ACROSS the two spine stages, which is why most
// fields here are optional:
//   - the identity stage writes `profile.profile_id` and
//     `profile.canonical_customer_id`, then emits to `identified.events`;
//   - the enrichment stage fills `profile.traits` / `profile.traits_version`
//     and the whole `enrichment` block, then emits to `resolved.events`.
// A schema demanding traits up front would make the intermediate family
// unrepresentable.
//
// See `docs/implementation/pipeline-redesign-plan.md` §4.4.
// ---------------------------------------------------------------------

/**
 * Platform resolution of the person an event belongs to.
 *
 * `traits` is a SNAPSHOT taken when the event was enriched, not a live
 * view: it is "latest as of delivery", and `traits_version` is what keeps a
 * historical delivery explainable after the profile has moved on. A
 * snapshot over the size guard is stored as `null` — the event still
 * carries its `profile_id` and is never dropped — so `traits: null` and
 * "not enriched yet" are deliberately the same shape.
 */
export const profileBlockSchema = z
  .object({
    profile_id: uuidSchema,
    canonical_customer_id: z.string().min(1).max(128).nullable(),
    traits: z.record(z.string(), z.unknown()).nullable().optional(),
    traits_version: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Geo enrichment derived from `context.ip`. */
export const geoEnrichmentSchema = z
  .object({
    country: z.string().max(8).nullable(),
    region: z.string().max(128).nullable(),
    city: z.string().max(128).nullable(),
    /**
     * Provenance of the lookup — the backend id, or `no_ip` / `no_lookup`
     * when there was nothing to resolve. Present even on a miss, so a null
     * geo is never ambiguous between "not attempted" and "attempted, found
     * nothing".
     */
    source: z.string().min(1).max(64),
  })
  .strict();

/**
 * Context enrichment attached by the enrichment stage.
 *
 * An object of nullable slots rather than one optional block per enricher:
 * an enricher that ran and found nothing is a different fact from one that
 * never ran, and the stage always runs all of them.
 */
export const enrichmentBlockSchema = z
  .object({
    geo: geoEnrichmentSchema.nullable(),
  })
  .strict();
