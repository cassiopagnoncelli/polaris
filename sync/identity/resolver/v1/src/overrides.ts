/**
 * Boot-time loader for per-project identity overrides.
 *
 * Reads the OPTIONAL `identity:` block from every
 * `catalog/projects/<project_id>.yaml` and returns the map that
 * `buildSyncIdentityApp` feeds into the policy resolver. This is the
 * production channel for the identifier denylist and the narrowed
 * semantic parameters — without it the safeguards exist as code with no
 * way to configure them.
 *
 * Failure behaviour is asymmetric on purpose:
 *
 *   - a MISSING catalog directory is a warning, not an error. Local runs
 *     and tests boot from directories that carry no catalog, and the
 *     correct policy there is manifest defaults for every project. The
 *     boot log states the override count either way, so a production
 *     image that lost its catalog is visible in one line.
 *   - a MALFORMED block fails the boot. The schema is `.strict()`
 *     (`@polaris/shared-policy`): a typo'd key must not become a
 *     safeguard that is silently not installed. Bounds are then checked
 *     eagerly by `createPolicyResolver`, so an out-of-range value also
 *     dies at boot instead of poisoning the project's feed at runtime.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "@polaris/shared-logger";
import {
  type ProjectIdentityOverride,
  projectIdentityOverrideSchema,
} from "@polaris/shared-policy";
import { parse as parseYaml } from "yaml";

export interface LoadOverridesOptions {
  /** Directory containing `catalog/projects/`. */
  readonly root: string;
  readonly logger: Logger;
}

export function loadProjectIdentityOverrides(
  options: LoadOverridesOptions,
): ReadonlyMap<string, ProjectIdentityOverride> {
  const projectsDir = join(options.root, "catalog", "projects");
  const overrides = new Map<string, ProjectIdentityOverride>();

  if (!existsSync(projectsDir)) {
    options.logger.warn(
      { component: "sync-identity.overrides", projects_dir: projectsDir },
      "no catalog/projects directory; every project runs manifest-default identity policy",
    );
    return overrides;
  }

  const files = readdirSync(projectsDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();

  for (const file of files) {
    const path = join(projectsDir, file);
    const data: unknown = parseYaml(readFileSync(path, "utf8"));
    if (typeof data !== "object" || data === null) {
      throw new Error(`catalog project file ${path} is not a YAML mapping`);
    }
    const record = data as Record<string, unknown>;
    const projectId = record["project_id"];
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new Error(`catalog project file ${path} has no project_id`);
    }
    if (record["identity"] === undefined) continue;

    const parsed = projectIdentityOverrideSchema.safeParse(record["identity"]);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`invalid identity block in ${path}: ${issues}`);
    }
    overrides.set(projectId, parsed.data);
  }

  options.logger.info(
    {
      component: "sync-identity.overrides",
      projects_dir: projectsDir,
      projects_with_overrides: overrides.size,
      project_ids: [...overrides.keys()],
    },
    "identity overrides loaded from catalog",
  );
  return overrides;
}
