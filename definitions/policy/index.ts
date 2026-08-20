/**
 * The forbidden-field policy registry.
 *
 * Two enforcement points read this module and they must agree: the
 * ingester at intake (`apps/ingester-api`, first pass) and the
 * destination runtime at delivery (`libs/delivery/destinations`, second
 * pass through `normalizeForDestination`). Before this file existed both
 * defaulted to an empty override map, so every project ran platform
 * defaults regardless of what its override file said.
 *
 * Registration is an explicit line here, not a directory scan — same
 * contract as `definitions/traits/index.ts`. Adding a project override means
 * adding a module and a line, a diff a reviewer can read, rather than
 * behaviour that depends on what happens to be on disk at boot.
 *
 * The registry is **deploy-time and file-backed**
 * (`docs/instructions/claude.md` "File-Heavy, DB-Light"): overrides are
 * code, they ship in the image, and nothing reloads them at runtime.
 * A reload would race the in-flight events whose intake decision was
 * taken under the previous policy.
 */

import { mergePolicy, type ProjectPolicyOverride } from "@polaris/governance";

import checkoutOverride from "./forbidden-fields.checkout.js";

export { default as checkoutOverride } from "./forbidden-fields.checkout.js";
export { platformPolicy } from "./forbidden-fields.js";

/**
 * Every project override, in a stable order.
 *
 * A project absent from this list runs platform defaults — which is the
 * behaviour every project had before the registry was wired, and is what
 * keeps adding the registry from changing anyone's policy by itself.
 */
const PROJECT_POLICY_OVERRIDE_LIST: readonly ProjectPolicyOverride[] = Object.freeze([
  checkoutOverride,
]);

/**
 * Build the registry, validating every override at module load.
 *
 * `mergePolicy` throws `PolicyMergeError` on an override that removes a
 * platform reject, or downgrades one to a redact without a
 * `documentedExceptions` entry. Running it here means an illegal override
 * fails the process at boot — where an operator sees it — rather than on
 * the first event from that project, where it would be one poisoned
 * partition and a policy quietly weaker than the file claims.
 *
 * The merged policy is DISCARDED. Only the validation matters at this
 * point: the per-event path hands the override to `evaluate()`, which
 * re-runs the merge itself. Keeping the merged copy would mean a second
 * representation of the effective policy that nothing reads and that
 * could drift from the one actually enforced.
 */
function buildRegistry(): ReadonlyMap<string, ProjectPolicyOverride> {
  const overrides = new Map<string, ProjectPolicyOverride>();
  for (const override of PROJECT_POLICY_OVERRIDE_LIST) {
    const existing = overrides.get(override.project_id);
    if (existing !== undefined) {
      throw new Error(
        `duplicate policy override registered for project '${override.project_id}' — one file per project`,
      );
    }
    // Throws PolicyMergeError on an illegal override. Deliberately not
    // caught: boot must fail.
    mergePolicy(override);
    overrides.set(override.project_id, override);
  }
  return overrides;
}

/**
 * `project_id` -> override. This is the map both enforcement points load
 * at boot: the ingester passes it to `createPolicyResolver`, the
 * destination host passes it to `createDestinationConsumer`.
 *
 * A plain map is the whole surface on purpose. `policyOverrideFor(id)` and
 * `mergedPolicyFor(id)` accessors lived here briefly and nothing outside
 * their own unit test ever called either — `.get()` is what both
 * enforcement points actually use.
 */
export const PROJECT_POLICY_OVERRIDES: ReadonlyMap<string, ProjectPolicyOverride> = buildRegistry();
