/**
 * Whether a reverse-ETL job may run for a project.
 *
 * Separate from `project-config.ts` on purpose. That module DECLARES the
 * namespace and its schema — it is the artifact `pnpm config-schemas`
 * reads, and a key whose only mention is its own declaration is operator
 * surface that changes nothing when set (`lint-project-config-keys.mjs`
 * says so, and excludes the declaring file from its scan for exactly that
 * reason). This module is what makes the key do something.
 *
 * It lives in the runner rather than in the CLI because the decision is
 * the component's, not the invocation's: a second caller — a future
 * daemon, a control-plane preview of "what would run tonight" — must get
 * the same answer without reimplementing it.
 */

import { PROJECT_CONFIG_NAMESPACE, projectConfigSchema } from "./project-config.js";

/**
 * Whether `job` may run for a project whose config slice is `values`.
 *
 * Takes the raw slice rather than a parsed config so a malformed value
 * cannot silently become "allowed". A slice that does not parse returns
 * `false` with the reason: on this path the safe failure is to skip the
 * run and say so, not to run something an operator may have been trying
 * to turn off.
 */
export function jobEnabled(
  job: string,
  values: Readonly<Record<string, unknown>>,
): { readonly enabled: boolean; readonly reason?: string } {
  const parsed = projectConfigSchema.safeParse(values);
  if (!parsed.success) {
    return {
      enabled: false,
      reason:
        `${PROJECT_CONFIG_NAMESPACE}.enabled_jobs did not parse ` +
        `(${parsed.error.issues.map((issue) => issue.message).join("; ")})`,
    };
  }
  const enabled = parsed.data.enabled_jobs;
  if (enabled === undefined) return { enabled: true };
  if (enabled.includes(job)) return { enabled: true };
  return {
    enabled: false,
    reason:
      enabled.length === 0
        ? `${PROJECT_CONFIG_NAMESPACE}.enabled_jobs is empty: no job runs for this project`
        : `${job} is not in ${PROJECT_CONFIG_NAMESPACE}.enabled_jobs [${enabled.join(", ")}]`,
  };
}
