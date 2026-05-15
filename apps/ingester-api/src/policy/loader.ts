import {
  type ForbiddenFieldPolicy,
  mergePolicy,
  type ProjectPolicyOverride,
} from "@polaris/shared-policy";

/**
 * Resolver for the merged forbidden-field policy per project.
 *
 * The platform defaults live in `@polaris/shared-policy/PLATFORM_DEFAULT_POLICY`
 * (re-exported by `catalog/policy/forbidden-fields.ts`). Project overrides
 * live in `catalog/policy/forbidden-fields.<project_id>.ts`. Per the docs
 * the override files are **file-backed**, not runtime mutable.
 *
 * To keep this package free of dynamic `import()` calls (which would couple
 * the ingester to a specific TypeScript compilation layout at runtime), the
 * loader accepts a `projectPolicies` map populated at startup by `app.ts`.
 * Future changes to the override discovery (CLI export, generated index)
 * land here without touching the handler.
 *
 * The resolver returns the `ProjectPolicyOverride` (or `undefined` for
 * platform-default projects) rather than a pre-merged policy. This matches
 * the `evaluate()` API in `@polaris/shared-policy`, which re-runs the
 * merge on every call to enforce the documented downgrade rules.
 */

export interface PolicyResolverOptions {
  /**
   * Static map of `project_id` -> override. Tests and the binary entry
   * point populate this at startup; the handler is stateless and reads
   * through the resolver on every request.
   */
  readonly projectPolicies?: ReadonlyMap<string, ProjectPolicyOverride>;
}

export interface PolicyResolver {
  /** Return the project override, or `undefined` if the project uses platform defaults. */
  resolve(projectId: string): ProjectPolicyOverride | undefined;
  /**
   * Return the merged platform + project policy. Used by the CLI policy
   * inspect command and by tests; the per-event handler reads through
   * `resolve()` and lets the evaluator do the merge internally.
   */
  merged(projectId: string): ForbiddenFieldPolicy;
}

/**
 * Build a `PolicyResolver`. The merged policies are memoised per
 * `project_id` so callers (CLI, tests) that inspect the same policy
 * many times pay the merge cost once.
 */
export function createPolicyResolver(options: PolicyResolverOptions = {}): PolicyResolver {
  const overrides = options.projectPolicies ?? new Map<string, ProjectPolicyOverride>();
  const memo = new Map<string, ForbiddenFieldPolicy>();

  function resolve(projectId: string): ProjectPolicyOverride | undefined {
    return overrides.get(projectId);
  }

  function merged(projectId: string): ForbiddenFieldPolicy {
    const cached = memo.get(projectId);
    if (cached !== undefined) return cached;
    const override = overrides.get(projectId);
    const result = mergePolicy(override).policy;
    memo.set(projectId, result);
    return result;
  }

  return { resolve, merged };
}
