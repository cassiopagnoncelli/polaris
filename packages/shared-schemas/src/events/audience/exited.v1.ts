import { z } from "zod";

/**
 * `audience.exited` v1 — ACTIVE.
 *
 * Emitted when an audience run finds a profile that no longer qualifies
 * and was a member. The mirror of `audience.entered`, and emitted under
 * the same restraint: transitions only.
 *
 * ## Why an exit is a first-class event
 *
 * A vendor audience that only ever receives additions grows without bound
 * and eventually describes everyone who ever qualified. Suppression, the
 * usual reason a marketer builds an audience at all, depends on the exit
 * arriving — "stop showing ads to people who bought" is entirely the exit
 * half. Emitting entries and leaving exits to a TTL somewhere downstream
 * would make the audience wrong in exactly the direction that costs money.
 *
 * ## Absent traits cause exits, and that is intended
 *
 * A profile leaves when the predicate stops holding, which includes the
 * case where a trait it reads went absent. Per `definitions/traits/types.ts`
 * an absent trait is "we do not know", not zero — so a trait that fails to
 * compute empties every audience built on it. That is the honest outcome:
 * an audience whose input is unknown has no defensible membership, and
 * silently holding the previous population would keep vendors acting on a
 * belief the platform no longer holds.
 */
export const audienceExitedV1PropertiesSchema = z
  .object({
    /** Catalog key from `definitions/audiences/`. */
    audience: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Definition version that evaluated this transition. */
    audience_version: z.number().int().positive(),
    /** Profile that left. */
    profile_id: z.string().uuid(),
    /** When the profile entered the membership this exit closes. */
    entered_at: z.string().datetime(),
    /** Run id of the computation that produced this transition. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type AudienceExitedV1Properties = z.infer<typeof audienceExitedV1PropertiesSchema>;
