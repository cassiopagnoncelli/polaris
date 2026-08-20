import { z } from "zod";

/**
 * `trait.computed` — one trait definition finished a computation run.
 *
 * The RUN-level record, deliberately not the per-profile one. A trait
 * touching a hundred thousand profiles emits one of these, and
 * `profile.updated` carries the per-profile detail — emitting a
 * `trait.computed` per profile would put the same information on the spine
 * twice and make a nightly run a hundred thousand events wide for no reader.
 *
 * What this answers is the operational question: did the trait run, over
 * how many profiles, and how many of them actually moved. That last number
 * is the one worth watching — a trait whose `changed` count jumps to the
 * full population overnight has usually had its definition edited, not its
 * customers.
 */
export const traitComputedV1PropertiesSchema = z
  .object({
    /** The definition's storage key, e.g. `orders_30d`. */
    trait_key: z.string().min(1).max(128),
    /** Profiles the definition returned a value for. */
    computed_count: z.number().int().nonnegative(),
    /** Profiles whose stored value actually changed. */
    changed_count: z.number().int().nonnegative(),
    /** Profiles whose value was removed — computed to nothing this run. */
    removed_count: z.number().int().nonnegative(),
    /** How long the definition's SQL took, milliseconds. */
    duration_ms: z.number().int().nonnegative(),
    /** Run id of the traits runner. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type TraitComputedV1Properties = z.infer<typeof traitComputedV1PropertiesSchema>;
