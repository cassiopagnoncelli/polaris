import { z } from "zod";

/**
 * `identity.merge_suspended` v1 — ACTIVE.
 *
 * Emitted by `sync/identity/resolver/v1` when a profile trips the
 * merge-rate breaker: it has absorbed more merges inside the window than
 * the manifest permits, which is the signature of a merge storm — one
 * promiscuous identifier chain-merging thousands of profiles into a single
 * mega-profile.
 *
 * The breaker stops that profile accepting further merges and raises this
 * event for an operator. It does NOT unwind merges already committed:
 * repair is a profile rebuild under a corrected denylist (replay), not an
 * inverse operation, because the merges are derived state and rebuilding is
 * the contract the whole plane is built on.
 */
export const identityMergeSuspendedV1PropertiesSchema = z
  .object({
    /** The profile that tripped the breaker. */
    profile_id: z.string().uuid(),
    /** Merges absorbed inside the window. */
    merge_count: z.number().int().positive(),
    /** The bound that was exceeded. */
    merge_limit: z.number().int().positive(),
    /** Window the count was measured over. */
    window_seconds: z.number().int().positive(),
    /** Event that would have caused the merge now refused. */
    source_event_id: z.string().uuid(),
    /** Run id that recorded the suspension. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type IdentityMergeSuspendedV1Properties = z.infer<
  typeof identityMergeSuspendedV1PropertiesSchema
>;
