import { z } from "zod";

/**
 * `audience.entered` v1 — ACTIVE.
 *
 * Emitted when an audience run finds a profile that qualifies and was not
 * already a member. One event per profile per transition — never one per
 * run, and never one per profile per run for members who did not move.
 *
 * That restraint is the contract. A destination consuming this stream is
 * entitled to read every event as a CHANGE: an audience of two million
 * profiles re-emitting membership nightly would be two million vendor
 * attribute writes a day describing nothing, and the first thing anyone
 * would do is filter it back down to transitions — badly, downstream,
 * without the stored state needed to do it correctly.
 *
 * `audience_version` is the definition version that made the call, so
 * "why is this profile in here" stays answerable after the predicate has
 * moved on. It is the version that EVALUATED the transition, which for a
 * profile that has been a member across several versions is the newest
 * one, not the one it originally joined under.
 */
export const audienceEnteredV1PropertiesSchema = z
  .object({
    /** Catalog key from `definitions/audiences/`. */
    audience: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Definition version that evaluated this transition. */
    audience_version: z.number().int().positive(),
    /** Profile that entered. */
    profile_id: z.string().uuid(),
    /**
     * True when this profile has been a member before and left.
     * Destinations that treat first entry differently from re-entry —
     * a welcome campaign, say — need the distinction, and the runner
     * knows it because the exited row survives.
     */
    re_entry: z.boolean(),
    /** Run id of the computation that produced this transition. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type AudienceEnteredV1Properties = z.infer<typeof audienceEnteredV1PropertiesSchema>;
