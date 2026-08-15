/**
 * `@polaris/processor-traits-v1` public surface.
 *
 * The runner and the diff are exported because the CLI drives them: this
 * processor has no long-lived service, so `polaris traits compute` IS its
 * entrypoint and the package is a library from the CLI's point of view.
 */

export { diffTrait, mergeChanges, type TraitChange } from "./diff.js";
export {
  type RunnableTrait,
  runTraits,
  type TraitEmitter,
  type TraitProfileStore,
  type TraitQueryRunner,
  type TraitRunInput,
  type TraitRunResult,
} from "./runner.js";
