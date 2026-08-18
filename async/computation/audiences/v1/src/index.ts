/**
 * `@polaris/processor-audiences-v1` public surface.
 *
 * The runner, the diff and the predicate evaluator are all exported
 * because the CLI drives them: this processor has no long-lived service,
 * so `polaris audiences compute` IS its entrypoint and the package is a
 * library from the CLI's point of view. Same arrangement as the traits
 * runner.
 */

export {
  type AudienceDiff,
  type AudienceTransition,
  type DiffAudienceInput,
  diffAudience,
  type EnteredTransition,
  type ExitedTransition,
  type StoredMembership,
} from "./diff.js";
export { evaluatePredicate, type TraitBag } from "./predicate.js";
export {
  type AudienceEmitter,
  type AudienceMembershipStore,
  type AudienceProfileStore,
  type AudienceQueryRunner,
  type AudienceRunInput,
  type AudienceRunResult,
  runAudiences,
} from "./runner.js";
