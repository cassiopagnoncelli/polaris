import { z } from "zod";

import { identityIdentifierSchema } from "./linked.v1.js";

/**
 * `identity.linked` v2 — ACTIVE.
 *
 * Emitted by `sync/identity/resolver/v1` when an identifier is bound to a
 * profile: either the profile was just created for it, or an existing
 * profile gained a new identifier.
 *
 * The v1/v2 break is not cosmetic. v1 described a PAIR — two identifiers
 * believed to be one person, with no notion of a person — because the
 * pairwise ledger had no profile to point at. v2 describes a BINDING:
 * identifier -> profile. That is why v2 has no `left`/`right` and why
 * `profile_id` is required: every v2 event names the person.
 *
 * `identity_links` survives underneath as the evidence ledger, so
 * `link_id` still joins back to the row justifying this binding.
 */
export const identityLinkedV2PropertiesSchema = z
  .object({
    /** The profile the identifier now resolves to. */
    profile_id: z.string().uuid(),
    /** The identifier that was bound, as `<kind>:<value>`. */
    identifier: identityIdentifierSchema,
    /**
     * True when this binding created the profile, false when it attached to
     * an existing one. Lets consumers count new people without a join.
     */
    profile_created: z.boolean(),
    /** UUIDv7 of the `identity_links` evidence row for this binding. */
    link_id: z.string().min(1).max(64),
    /** Open vocabulary; v1 of the resolver writes `explicit_overlap`. */
    evidence_type: z.string().min(1).max(64),
    /** Event that produced the evidence. */
    source_event_id: z.string().uuid(),
    /** Run id that recorded the binding. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type IdentityLinkedV2Properties = z.infer<typeof identityLinkedV2PropertiesSchema>;
