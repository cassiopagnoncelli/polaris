import { z } from "zod";

/**
 * `session.started` v1 — ACTIVE.
 *
 * Emitted by `async/computation/sessionizer/v1/` the first time the sessionizer
 * observes a `raw.events` envelope for a `(project_id, environment,
 * primary_identifier)` key whose prior session has expired (or never
 * existed). Subsequent events inside the inactivity window do NOT
 * re-emit this — only the lazy expiration on the next event for the
 * same key (or replay) produces another start.
 *
 * v1 picks `primary_identifier_kind` from the canonical envelope's
 * `identity` block in preference order
 *   1. `customer_id`   (stable across rotations)
 *   2. `anonymous_id`  (SDK-managed; rotates on reset())
 *   3. `session_id`    (SDK hint; rotates on its own clock)
 * The SDK's `session_id` is treated as a HINT only — the sessionizer's
 * `session_id` (the property emitted here) is its own deterministic
 * derivation. See `docs/implementation/tasks/P8-003-sessionizer-v1.md`.
 *
 * `session_id` is derived deterministically from
 * `(primary_identifier_kind, primary_identifier_value, started_at)` so a
 * replay over the same `raw.events` slice produces the same value.
 */

/**
 * Kind of identifier the sessionizer keyed the session on. Mirrors the
 * canonical envelope's `identity` field names so downstream consumers
 * can join the session back to the originating identity field.
 */
export const sessionPrimaryIdentifierKindSchema = z.enum([
  "customer_id",
  "anonymous_id",
  "session_id",
]);
export type SessionPrimaryIdentifierKind = z.infer<typeof sessionPrimaryIdentifierKindSchema>;

export const sessionStartedV1PropertiesSchema = z
  .object({
    /**
     * Deterministic session identifier. v1 derives this from
     * `(primary_identifier_kind, primary_identifier_value, started_at)` so
     * the same `raw.events` slice produces the same `session_id` on replay.
     * The format is `sess_<32-hex>` — opaque to consumers.
     */
    session_id: z
      .string()
      .min(5)
      .max(64)
      .regex(/^sess_[0-9a-f]+$/u, {
        message: "session_id must be 'sess_<hex>'",
      }),
    /**
     * Kind of identifier the sessionizer keyed on. Determined by the
     * preference order in v1: customer_id > anonymous_id > session_id.
     */
    primary_identifier_kind: sessionPrimaryIdentifierKindSchema,
    /**
     * Value of the primary identifier the session was keyed on. Mirrors
     * the corresponding field in the source event's `identity` block.
     */
    primary_identifier_value: z.string().min(1).max(256),
    /** ISO 8601 UTC start of the session window. Mirrors the source event's `occurred_at`. */
    started_at: z.string().datetime({ offset: false }),
    /**
     * Source event id (UUIDv7) that triggered the session start. Useful
     * for lineage queries.
     */
    source_event_id: z.string().min(1).max(64),
    /** Run id of the sessionizer invocation that recorded the start. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type SessionStartedV1Properties = z.infer<typeof sessionStartedV1PropertiesSchema>;
