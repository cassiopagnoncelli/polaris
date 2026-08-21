/**
 * `@polaris/profiles` — the person an event resolves to.
 *
 * ADR-0007 lists this beside the identity modules rather than inside
 * them, and the split is the one the pipeline redesign draws: identity
 * is the graph — which identifiers are the same person — and a profile
 * is what that person IS, the aggregate carrying external ids, traits
 * and a canonical customer id. `@polaris/identity-graph` maintains the
 * graph and produces the aggregate; nothing here knows how it is stored.
 *
 * `sync/identity/resolver/v1` remains the profile store's only sync-path
 * writer. That is a deployment rule, not something a library can
 * enforce, and it is stated here because this is where a second writer
 * would come looking for a port to write through.
 */

export { type BoundIdentifier, pickCanonicalCustomerId } from "./external-ids.js";
export {
  type ProfileRepository,
  type ResolutionKind,
  type ResolutionResult,
  type ResolveInput,
  unidentifiedResolution,
} from "./resolution.js";
export {
  applyTraitPatch,
  extractTraits,
  type TraitPatch,
  type TraitState,
} from "./traits.js";
