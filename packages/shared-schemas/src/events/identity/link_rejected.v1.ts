import { z } from "zod";

import { identityIdentifierSchema } from "./linked.v1.js";

/**
 * `identity.link_rejected` v1 — ACTIVE.
 *
 * Emitted by `sync/identity/resolver/v1` when a binding is refused by a
 * merge safeguard rather than accepted. Two causes, both from the plan's
 * merge-safety rules:
 *
 *   `identifier_cap`  the profile already holds the maximum bindings of
 *                     this kind — a runaway producer cannot inflate one
 *                     profile into a hot row that stalls its partition;
 *   `denylisted`      the identifier VALUE is on the catalog denylist
 *                     (kiosk device ids, `customer_id: "guest"`, bot
 *                     anonymous ids) and resolves as if absent.
 *
 * The event exists because a silent refusal is indistinguishable from a
 * producer bug. The rejection is observable, the event still flows, and the
 * profile is left intact.
 */
export const identityLinkRejectedV1PropertiesSchema = z
  .object({
    /** Profile the binding would have attached to, when one was resolved. */
    profile_id: z.string().uuid().nullable(),
    /** The identifier that was refused. */
    identifier: identityIdentifierSchema,
    /** Why it was refused. */
    reason: z.enum(["identifier_cap", "denylisted"]),
    /** Bindings of this kind already held, for the cap case. */
    existing_binding_count: z.number().int().nonnegative().nullish(),
    /** Event carrying the refused identifier. */
    source_event_id: z.string().uuid(),
    /** Run id that recorded the refusal. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type IdentityLinkRejectedV1Properties = z.infer<
  typeof identityLinkRejectedV1PropertiesSchema
>;
