/**
 * The journey registry.
 *
 * Every journey the platform runs. Adding one means adding a module and a
 * line here — a diff a reviewer can read, rather than a directory scan
 * whose contents depend on what happens to be on disk. Same contract as
 * `definitions/audiences/index.ts` and `definitions/traits/index.ts`.
 *
 * Definitions are code and deploy-time. What a journey MEANS is versioned
 * with the repository; only PARTICIPATION — where a profile is in the
 * graph right now — is runtime state, and that lives in
 * `journey_participants`.
 */

export {
  edgesOf,
  JOURNEY_EVENT_NAMESPACE,
  JOURNEY_EVENTS,
  type JourneyDefinition,
  type JourneyEvent,
  type JourneyReentry,
  type JourneyStep,
  type JourneyTrigger,
  journeyDefinitionSchema,
  journeyReentrySchema,
  journeyStepSchema,
  journeyTriggerSchema,
  MAX_JOURNEY_STEPS,
  traitsReferencedByJourney,
} from "./types.js";
export { welcomeRecentPurchasers } from "./welcome-recent-purchasers.js";

import type { JourneyDefinition } from "./types.js";
import { welcomeRecentPurchasers } from "./welcome-recent-purchasers.js";

/**
 * Every journey, in a stable order.
 *
 * Duplicate (key, version) pairs are rejected here rather than at first
 * run: two graphs claiming one version would have participants walking
 * different definitions while recording the same entry version, and "which
 * graph did this person actually take" would have no answer.
 */
function buildRegistry(): readonly JourneyDefinition[] {
  const definitions: readonly JourneyDefinition[] = Object.freeze([welcomeRecentPurchasers]);
  const seen = new Set<string>();
  for (const definition of definitions) {
    const identity = `${definition.key}@${String(definition.version)}`;
    if (seen.has(identity)) {
      throw new Error(
        `duplicate journey registered for ${identity} — one graph per (key, version)`,
      );
    }
    seen.add(identity);
  }
  return definitions;
}

export const JOURNEY_DEFINITIONS: readonly JourneyDefinition[] = buildRegistry();
