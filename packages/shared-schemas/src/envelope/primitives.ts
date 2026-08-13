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
