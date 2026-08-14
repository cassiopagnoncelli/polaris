import { z } from "zod";

import { sessionPrimaryIdentifierKindSchema } from "./started.v1.js";

/**
 * `session.ended` v1 — ACTIVE.
 *
 * Emitted by `async/computation/sessionizer/v1/` when a session window expires
 * by inactivity. v1 detects expiration lazily: when a new `raw.events`
 * envelope arrives for a `(project_id, environment, primary_identifier)`
 * key whose current session's `last_seen_at` is older than the
 * configured inactivity window, the sessionizer emits `session.ended`
 * for the prior session AND `session.started` for the new one (in that
 * order). There is no background timer in v1 — sessions garbage-collect
 * on the next observed event for the same key.
 *
 * `ended_at` is the WINDOW BOUNDARY (`last_seen_at + inactivity_seconds`),
 * not the moment the sessionizer detected the expiration. Anchoring the
 * end timestamp to the boundary keeps the downstream timeline stable
 * across replays — a replay run later in real-time emits the same
 * `ended_at` as the original.
 */
export const sessionEndedV1PropertiesSchema = z
  .object({
    /** The same `session_id` that was emitted by the prior `session.started`. */
    session_id: z
      .string()
      .min(5)
      .max(64)
      .regex(/^sess_[0-9a-f]+$/u, {
        message: "session_id must be 'sess_<hex>'",
      }),
    /** Same kind that opened the session. */
    primary_identifier_kind: sessionPrimaryIdentifierKindSchema,
    /** Same value that opened the session. */
    primary_identifier_value: z.string().min(1).max(256),
    /** ISO 8601 UTC start of the session window (mirrors session.started). */
    started_at: z.string().datetime({ offset: false }),
    /**
     * ISO 8601 UTC end of the session window. Equal to
     * `last_seen_at + inactivity_seconds` so the timestamp is stable
     * across replays.
     */
    ended_at: z.string().datetime({ offset: false }),
    /**
     * Last `occurred_at` observed for an event in this session before
     * inactivity closed the window.
     */
    last_seen_at: z.string().datetime({ offset: false }),
    /** Inactivity window (seconds) used to decide the session ended. */
    inactivity_seconds: z.number().int().positive().max(86_400),
    /**
     * Total `raw.events` observations counted in the session window.
     * Includes the original event that opened the session.
     */
    event_count: z.number().int().min(1).max(10_000_000),
    /** Run id of the sessionizer invocation that recorded the end. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type SessionEndedV1Properties = z.infer<typeof sessionEndedV1PropertiesSchema>;
