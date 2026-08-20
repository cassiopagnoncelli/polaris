/**
 * The violation record — the quarantine's wire shape.
 *
 * NOT a canonical envelope, and it cannot be: the event failed validation
 * by definition, so it may have no `event_id`, no `occurred_at`, no valid
 * `event` name, or not be an object at all. Every one of those is a thing
 * the quarantine exists to record, and an envelope-shaped record would
 * have to invent the missing fields before it could carry the news that
 * they were missing.
 *
 * ## Versioned independently of the envelope
 *
 * `violation_version` is its own number. The envelope's `schema_version`
 * describes a producer's event; this describes the platform's report ABOUT
 * a rejected event, and the two change for unrelated reasons. Tying them
 * together would mean every envelope revision forced a quarantine
 * migration, and a quarantine change would look like an event-contract
 * change to everyone reading the catalog.
 *
 * ## What it may carry
 *
 * Reason code, field paths, and a sample with every policy redaction
 * applied (`buildViolationSample` in `@polaris/governance`). Paths are
 * dotted strings — the same discipline the batch response follows, and
 * what makes "which projects still send `cvv`?" answerable without the
 * quarantine becoming a second copy of the data it exists to keep out.
 */

import { z } from "zod";

/**
 * Current record version.
 *
 * Bump when a consumer that understands version N would MISREAD a version
 * N+1 record. Adding an optional field is not that; changing what `paths`
 * means is.
 */
export const VIOLATION_RECORD_VERSION = 1;

/**
 * A quarantined rejection.
 *
 * `event`, `event_id` and `schema_version` are nullable because a rejected
 * payload may not have supplied them — or may have supplied something that
 * is not a string. They are recorded as hints, never trusted.
 */
export const violationRecordSchema = z.object({
  violation_version: z.number().int().positive(),
  /** Platform-issued, UUIDv7. Not the producer's event_id. */
  violation_id: z.string().min(1),
  /** From the API key tuple, so always present and always trustworthy. */
  project_id: z.string().min(1),
  environment: z.string().min(1),
  /** Producer-supplied hints. Null when absent or not a string. */
  event: z.string().nullable(),
  event_id: z.string().nullable(),
  schema_version: z.number().int().nullable(),
  /** Closed-set batch reason code — why the ingester refused it. */
  reason: z.string().min(1),
  /**
   * Dotted field paths implicated in the rejection: the rejecting path
   * for a policy reject, the failing paths for a catalog validation
   * failure. Never values.
   */
  paths: z.array(z.string()),
  /** JSON, with every policy redaction applied. See the module header. */
  redacted_sample: z.string(),
  /** When the ingester received it, ISO 8601 UTC. */
  received_at: z.string().min(1),
});

export type ViolationRecord = z.infer<typeof violationRecordSchema>;

/**
 * Parse a violation record, or `null`.
 *
 * Returns null rather than throwing because every consumer of this record
 * is a diagnostic path — a sink, a CLI listing — and none of them should
 * fail on a malformed row. A quarantine that stops working because
 * something malformed landed in it is a quarantine that stops working
 * exactly when the platform is producing malformed things.
 */
export function parseViolationRecord(value: unknown): ViolationRecord | null {
  const parsed = violationRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
