/**
 * The vocabulary behind `identity.link_rejected` v1 and
 * `identity.merge_suspended` v1.
 *
 * Both events shipped with the resolver, and their MEANING is what this
 * module holds: a rejection is a binding that did not happen and the
 * reason it did not, a suspension is a merge the breaker refused. The
 * envelope those facts travel in belongs to the stage that emits them —
 * `sync/identity/resolver/v1/src/emit.ts` — because event schema is a
 * wire contract, not physics.
 *
 * Keeping the reasons in one closed union is the point. Two guards
 * refuse a binding for two unrelated causes (a denylisted value, a
 * per-kind cap), and an operator watching the fact stream wants one
 * question answered — "a binding did not happen, why?" — rather than two
 * vocabularies that happen to be adjacent.
 */

import type { StrongIdentityKind } from "@polaris/identity-rules";

/**
 * Why a binding was refused.
 *
 * `denylisted` is decided before resolution, at identifier collection;
 * `identifier_cap` during it, against the profile's existing bindings.
 * They are reported the same way on purpose — the difference matters to
 * whoever fixes it, not to whoever notices it.
 */
export type LinkRejectionReason = "identifier_cap" | "denylisted";

/** One identifier that did not bind, and why. */
export interface RejectedIdentifier {
  readonly kind: StrongIdentityKind;
  readonly value: string;
  readonly reason: LinkRejectionReason;
  /** Bindings of this kind the profile already held. Cap refusals only. */
  readonly existingBindingCount?: number;
}

/**
 * The merge fact: two profiles turned out to be one person.
 *
 * `identifiersMoved` is the size of the repoint, and it is on the fact
 * rather than derivable from it because repointing is eager — after the
 * merge commits there is nothing left pointing at the loser to count.
 */
export interface MergeOutcome {
  readonly mergeId: string;
  readonly winnerProfileId: string;
  readonly loserProfileId: string;
  readonly identifiersMoved: number;
}
