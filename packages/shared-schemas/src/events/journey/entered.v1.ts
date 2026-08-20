import { z } from "zod";

/**
 * `journey.entered` v1 — ACTIVE.
 *
 * Emitted when a profile is admitted to a journey. One event per
 * participation, not per evaluation: a trigger that fires for a profile
 * already participating produces nothing, because entry is idempotent per
 * `(journey, profile)`.
 *
 * `journey_version` is the graph the participant will walk to completion.
 * It is recorded here and never revised: a participant finishes on the
 * version it entered on, so "which graph did this person actually take" is
 * answerable long after the definition has moved on.
 *
 * Deliberately in the `journey.*` namespace, which
 * `definitions/journeys/types.ts` forbids as a trigger. Without that rule an
 * event like this one could admit a profile to another journey whose
 * action emits another, and the pair would run as fast as the spine
 * carries messages.
 */
export const journeyEnteredV1PropertiesSchema = z
  .object({
    /** Catalog key from `definitions/journeys/`. */
    journey: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Graph version this participant will walk to completion. */
    journey_version: z.number().int().positive(),
    /** Profile admitted. */
    profile_id: z.string().uuid(),
    /** Step the participant starts on. */
    step_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** What admitted them — an audience key, or an event name. */
    trigger: z.string().min(1).max(128),
    /** True when this profile has completed the journey before. */
    re_entry: z.boolean(),
    /** The orchestrator run that admitted them. */
    run_id: z.string().min(1).max(128),
  })
  .strict();

export type JourneyEnteredV1Properties = z.infer<typeof journeyEnteredV1PropertiesSchema>;
