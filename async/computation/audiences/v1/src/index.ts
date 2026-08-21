/**
 * `@polaris/processor-audiences-v1` public surface.
 *
 * The runner and its four seams. The CLI drives them: this processor has
 * no long-lived service, so `polaris audiences compute` IS its entrypoint
 * and the package is a library from the CLI's point of view. Same
 * arrangement as the traits runner.
 *
 * The audience semantics themselves — predicate, population, entered and
 * exited signals — are `@polaris/engage-audiences`. The types a caller
 * needs in order to READ a run's result are re-exported here so the CLI
 * imports one package to run an audience pass, rather than one to call the
 * runner and a second to name what it returned.
 */

export {
  type AudienceEmitter,
  type AudienceMembershipStore,
  type AudienceProfileStore,
  type AudienceQueryRunner,
  type AudienceRunInput,
  type AudienceRunResult,
  runAudiences,
} from "./runner.js";
export {
  type AudienceSummary,
  type AudienceTransition,
  type EnteredTransition,
  type ExitedTransition,
  evaluatePredicate,
  type StampedMembership,
  type StoredMembership,
  type TraitBag,
} from "@polaris/engage-audiences";
