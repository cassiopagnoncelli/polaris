/**
 * `@polaris/engage-audiences` public surface.
 *
 * Audience meaning, with no runtime identity: a predicate evaluator, the
 * population a definition selects over trait rows, and the entered/exited
 * signals that population produces against stored membership.
 *
 * The seams — the profile store, the membership store, the emitter, the
 * projection query runner — are deliberately NOT here. They are the
 * runtime's shape rather than the audience's meaning, so they live beside
 * `runAudiences` in `async/computation/audiences/v1`, which is the one
 * thing that holds all four at once.
 */

export {
  type AudiencePlan,
  type AudienceSummary,
  membersMatching,
  planAudience,
  type ProfileTraits,
  type StampedMembership,
} from "./evaluator.js";
export { evaluatePredicate, type TraitBag } from "./predicate.js";
export type {
  AudienceTransition,
  EnteredTransition,
  ExitedTransition,
  StoredMembership,
} from "./signals.js";
