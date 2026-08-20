import { z } from "zod";

/**
 * `identity.merged` v2 — ACTIVE.
 *
 * Emitted by `sync/identity/resolver/v1` when an event proves two profiles
 * are one person. The winner is the older profile (`first_seen_at`, ties
 * broken by the lower id); the loser's identifiers are repointed inside the
 * same transaction and its row is tombstoned.
 *
 * This event is the trigger for the retroactive-merge worker (R4), which
 * maintains the ClickHouse canonical-profile dictionary so person-keyed
 * reads resolve the loser to the winner. History is never rewritten — it is
 * re-interpreted at read time — which is why both ids ride the event
 * permanently rather than only the survivor.
 *
 * v1 could not express any of this: it recorded that two *links* collapsed,
 * and stated outright that re-attribution was deferred. v2 is what makes it
 * no longer deferred.
 */
export const identityMergedV2PropertiesSchema = z
  .object({
    /** Surviving profile. All identifiers now point here. */
    winner_profile_id: z.string().uuid(),
    /** Tombstoned profile. Retained for lineage, never resolved to again. */
    loser_profile_id: z.string().uuid(),
    /** UUIDv7 of the `profile_merges` audit row. */
    merge_id: z.string().uuid(),
    /** How many identifier bindings moved from loser to winner. */
    identifiers_moved: z.number().int().nonnegative(),
    /** Event whose identifiers proved the two profiles were one person. */
    source_event_id: z.string().uuid(),
    /** Short human-readable explanation. */
    reason: z.string().min(1).max(2048),
    /** Run id that recorded the merge. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type IdentityMergedV2Properties = z.infer<typeof identityMergedV2PropertiesSchema>;
