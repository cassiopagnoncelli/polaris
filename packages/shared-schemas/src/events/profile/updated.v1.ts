import { z } from "zod";

/**
 * `profile.updated` v1 — ACTIVE.
 *
 * Emitted whenever a profile's traits change, by any of the three sanctioned
 * writers: the identity stage (identify-family events), the computed-traits
 * runner (R5), and reverse ETL (R7). `writer` says which.
 *
 * This event is how trait HISTORY exists at all. `profiles.traits` in
 * Postgres holds only the current value — deliberately, since it is runtime
 * state on the hot path — so the audit trail of what a profile believed and
 * when lives in ClickHouse, fed by this stream. It is also what the
 * profiles table and the scheduled profile export are built from.
 *
 * Carries the CHANGED keys, not the whole trait bag: a full snapshot per
 * update would multiply storage by the trait count for no gain, and the
 * current state is always one `argMax` away.
 */
export const profileUpdatedV1PropertiesSchema = z
  .object({
    /** Profile whose traits changed. */
    profile_id: z.string().uuid(),
    /** Monotonic revision after this change. */
    traits_version: z.number().int().nonnegative(),
    /** Which sanctioned writer made the change. */
    writer: z.enum(["identity_stage", "computed_traits", "reverse_etl"]),
    /** The traits set by this update — changed keys only. */
    traits: z.record(z.string(), z.unknown()),
    /** Trait keys removed by this update, if any. */
    removed_keys: z.array(z.string().min(1).max(128)).nullish(),
    /** Event that caused the change, when a single event did. */
    source_event_id: z.string().uuid().nullish(),
    /** Run id of the writer. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type ProfileUpdatedV1Properties = z.infer<typeof profileUpdatedV1PropertiesSchema>;
