/**
 * The audience registry.
 *
 * Every audience the platform computes. Adding one means adding a module
 * and a line here — a diff a reviewer can read, rather than a directory
 * scan whose contents depend on what happens to be on disk. Same contract
 * as `catalog/traits/index.ts` and `catalog/policy/index.ts`.
 *
 * Definitions are code and deploy-time. What an audience MEANS is versioned
 * with the repository; only MEMBERSHIP — which profile is in it right now —
 * is runtime state, and that lives in `audience_memberships`.
 */

export { recentPurchasers } from "./recent-purchasers.js";
export {
  AUDIENCE_OPERATORS,
  AUDIENCE_SOURCES,
  type AudienceComparison,
  type AudienceDefinition,
  type AudienceOperator,
  type AudiencePredicate,
  type AudienceSource,
  audienceComparisonSchema,
  audienceDefinitionSchema,
  audiencePredicateSchema,
  MAX_PREDICATE_DEPTH,
  predicateDepth,
  traitsReferenced,
} from "./types.js";

import { recentPurchasers } from "./recent-purchasers.js";
import type { AudienceDefinition } from "./types.js";

/**
 * Every audience, in a stable order.
 *
 * Duplicate keys are rejected here rather than at first run: two
 * definitions claiming one key would have the runner compute membership
 * twice for the same population and emit contradictory transitions, and
 * the second write would silently win.
 */
function buildRegistry(): readonly AudienceDefinition[] {
  const definitions: readonly AudienceDefinition[] = Object.freeze([recentPurchasers]);
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.key)) {
      throw new Error(
        `duplicate audience registered for key '${definition.key}' — one definition per key`,
      );
    }
    seen.add(definition.key);
  }
  return definitions;
}

export const AUDIENCE_DEFINITIONS: readonly AudienceDefinition[] = buildRegistry();
