import { z } from "zod";

/**
 * `journey.step_advanced` v1 — ACTIVE.
 *
 * Emitted when a participant moves from one step to the next, and by an
 * `action` step as the event a destination acts on. Both are the same
 * fact — the participant is now here — so they are one event rather than
 * two, and a destination mapper reads `properties` to decide what to send.
 *
 * `properties` is the action's free-form payload, carried through
 * untouched. The orchestrator does not interpret it: deciding what a
 * `message: "thank_you_repeat"` means is the destination's job, and an
 * orchestrator that understood vendor payloads would be making vendor
 * decisions one layer too early.
 */
export const journeyStepAdvancedV1PropertiesSchema = z
  .object({
    journey: z.string().regex(/^[a-z][a-z0-9_]*$/),
    journey_version: z.number().int().positive(),
    profile_id: z.string().uuid(),
    /** Step just entered. */
    step_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Step left, absent on the first advance out of entry. */
    from_step_id: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .nullish(),
    /** An action step's payload, carried through uninterpreted. */
    properties: z.record(z.string(), z.unknown()).nullish(),
    run_id: z.string().min(1).max(128),
  })
  .strict();

export type JourneyStepAdvancedV1Properties = z.infer<typeof journeyStepAdvancedV1PropertiesSchema>;
