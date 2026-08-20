import { z } from "zod";

import { identityIdentifierSchema } from "./linked.v1.js";

/**
 * `identity.merged` v1 — ACTIVE.
 *
 * Emitted by `sync/legacy/identity-resolver/v1/` when an authoritative overlap
 * collapses two previously-separate canonical identities onto one. The
 * canonical example: an `anonymous_id` was previously linked to one
 * `customer_id`, and the resolver now observes the same `anonymous_id`
 * appearing alongside a different `customer_id` in the same event.
 *
 * v1 of the resolver records the conflict by inserting two rows in
 * `identity_links` (one per (left, right) tuple) and emitting this event so
 * downstream consumers can detect the merge. The semantics of merging itself
 * (which side wins, how historical events are re-attributed) are deferred to
 * later identity work — v1 only records the *fact* of the merge.
 */
export const identityMergedV1PropertiesSchema = z
  .object({
    /**
     * UUIDv7 of the **newly inserted** `identity_links` row that triggered
     * the merge. The previous (now-superseded) row id is in
     * `superseded_link_id`.
     */
    link_id: z.string().min(1).max(64),
    /** Identifier carried over from the new event (e.g. `customer_id:cus_B`). */
    new_identifier: identityIdentifierSchema,
    /**
     * Identifier that was previously linked to a different counterpart
     * (e.g. `anonymous_id:anon_X`). This is the "shared" half whose binding
     * is moving.
     */
    shared_identifier: identityIdentifierSchema,
    /**
     * Identifier that was previously bound to `shared_identifier` and is
     * being superseded (e.g. `customer_id:cus_A`).
     */
    superseded_identifier: identityIdentifierSchema,
    /**
     * UUIDv7 of the previous `identity_links` row that is now superseded by
     * the new link.
     */
    superseded_link_id: z.string().min(1).max(64),
    /** Short human-readable explanation. */
    reason: z.string().min(1).max(2048),
    /** Run id that recorded the merge. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type IdentityMergedV1Properties = z.infer<typeof identityMergedV1PropertiesSchema>;
