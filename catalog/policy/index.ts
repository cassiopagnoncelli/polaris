/**
 * The forbidden-field policy registry.
 *
 * Two enforcement points read this module and they must agree: the
 * ingester at intake (`apps/ingester-api`, first pass) and the
 * destination runtime at delivery (`packages/shared-destinations`, second
 * pass through `normalizeForDestination`). Before this file existed both
 * defaulted to an empty override map, so every project ran platform
 * defaults regardless of what its override file said.
 *
 * Registration is an explicit line here, not a directory scan — same
 * contract as `catalog/traits/index.ts`. Adding a project override means
 * adding a module and a line, a diff a reviewer can read, rather than
 * behaviour that depends on what happens to be on disk at boot.
 *
 * The registry is **deploy-time and file-backed**
 * (`docs/instructions/claude.md` "File-Heavy, DB-Light"): overrides are
 * code, they ship in the image, and nothing reloads them at runtime.
 * A reload would race the in-flight events whose intake decision was
 * taken under the previous policy.
 */

import {
  mergePolicy,
  type ForbiddenFieldPolicy,
  type ProjectPolicyOverride,
} from "@polaris/shared-policy";

import checkoutOverride from "./forbidden-fields.checkout.js";

export { platformPolicy } from "./forbidden-fields.js";
export { default as checkoutOverride } from "./forbidden-fields.checkout.js";

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
 * Validate every registered override at module load.
 *
 * `mergePolicy` throws `PolicyMergeError` on an override that removes a
 * platform reject, or downgrades one to a redact without a
 * `documentedExceptions` entry. Running it here means an illegal override
 * fails the process at boot — where an operator sees it — rather than on
 * the first event from that project, where it would be one poisoned
 * partition and a policy quietly weaker than the file claims.
 *
 * The merged result is kept: `mergedPolicyFor` hands it back, and the
 * per-event path re-runs the merge inside `evaluate()` anyway.
 */
function buildRegistry(): {
  readonly overrides: ReadonlyMap<string, ProjectPolicyOverride>;
  readonly merged: ReadonlyMap<string, ForbiddenFieldPolicy>;
} {
  const overrides = new Map<string, ProjectPolicyOverride>();
  const merged = new Map<string, ForbiddenFieldPolicy>();
  for (const override of PROJECT_POLICY_OVERRIDE_LIST) {
    const existing = overrides.get(override.project_id);
    if (existing !== undefined) {
      throw new Error(
        `duplicate policy override registered for project '${override.project_id}' — one file per project`,
      );
    }
    // Throws PolicyMergeError on an illegal override. Deliberately not
    // caught: boot must fail.
    merged.set(override.project_id, mergePolicy(override).policy);
    overrides.set(override.project_id, override);
  }
  return { overrides, merged };
}

const REGISTRY = buildRegistry();

/**
 * `project_id` -> override. This is the map both enforcement points load
 * at boot: the ingester passes it to `createPolicyResolver`, the
 * destination host passes it to `createDestinationConsumer`.
 */
export const PROJECT_POLICY_OVERRIDES: ReadonlyMap<string, ProjectPolicyOverride> =
  REGISTRY.overrides;

/** The override for a project, or `undefined` when it runs platform defaults. */
export function policyOverrideFor(projectId: string): ProjectPolicyOverride | undefined {
  return REGISTRY.overrides.get(projectId);
}

/**
 * The merged platform + project policy for a project. Used by
 * `polaris policy inspect` and by tests that assert the effective rules;
 * the per-event paths read the override and let the evaluator merge.
 */
export function mergedPolicyFor(projectId: string): ForbiddenFieldPolicy {
  const cached = REGISTRY.merged.get(projectId);
  if (cached !== undefined) return cached;
  return mergePolicy(undefined).policy;
}
