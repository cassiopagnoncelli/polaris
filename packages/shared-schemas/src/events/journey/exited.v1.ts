import { z } from "zod";

/**
 * `journey.exited` v1 — ACTIVE.
 *
 * Emitted when a participation ends, for any reason. `reason` is a closed
 * set because it is what a funnel projection groups by: "completed" and
 * "merged_away" are very different outcomes, and a free-text field would
 * make the difference unqueryable within a month.
 *
 * `merged_away` is the identity case. Participations key on `profile_id`,
 * and when two profiles merge the loser's are exited rather than
 * transferred: the winner may already be participating, and a half-walked
 * graph from another identity is not a state the winner ever qualified
 * for. It enters on its own merits at the next trigger.
 */
export const JOURNEY_EXIT_REASONS = [
  "completed",
  "exit_step",
  "merged_away",
  "definition_retired",
] as const;

export const journeyExitedV1PropertiesSchema = z
  .object({
    journey: z.string().regex(/^[a-z][a-z0-9_]*$/),
    journey_version: z.number().int().positive(),
    profile_id: z.string().uuid(),
    /** Step the participant was on when it ended. */
    step_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    reason: z.enum(JOURNEY_EXIT_REASONS),
    run_id: z.string().min(1).max(128),
  })
  .strict();

export type JourneyExitedV1Properties = z.infer<typeof journeyExitedV1PropertiesSchema>;
