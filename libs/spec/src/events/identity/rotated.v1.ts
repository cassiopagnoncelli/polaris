import { z } from "zod";

import { identityIdentifierSchema } from "./linked.v1.js";

/**
 * `identity.rotated` v1 — ACTIVE.
 *
 * Emitted by `sync/legacy/identity-resolver/v1/` when an authoritative event
 * tells the resolver that an `anonymous_id` (or other rotating identifier)
 * has rolled while the strong identifier (typically `customer_id`) stayed
 * stable. The canonical trigger is the Web SDK's `reset()` flow described in
 * `docs/architecture/10-sdk-standards.md` — rotating `anonymous_id` while the
 * customer remains identified. v1 of the resolver detects this when a new
 * `anonymous_id` arrives alongside an already-bound `customer_id`.
 *
 * Like `identity.merged`, v1 records the rotation as a new row in
 * `identity_links` plus this event for downstream lineage. Re-attribution of
 * historical events to the new anonymous identifier is deferred to later
 * identity work.
 */
export const identityRotatedV1PropertiesSchema = z
  .object({
    /** UUIDv7 of the new `identity_links` row representing the rotation. */
    link_id: z.string().min(1).max(64),
    /**
     * Strong identifier that stayed stable across the rotation
     * (e.g. `customer_id:cus_123`).
     */
    stable_identifier: identityIdentifierSchema,
    /** New rotating identifier (e.g. `anonymous_id:anon_new`). */
    new_identifier: identityIdentifierSchema,
    /** Previous rotating identifier (e.g. `anonymous_id:anon_old`). */
    previous_identifier: identityIdentifierSchema,
    /** Short human-readable explanation. */
    reason: z.string().min(1).max(2048),
    /** Run id that recorded the rotation. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type IdentityRotatedV1Properties = z.infer<typeof identityRotatedV1PropertiesSchema>;
