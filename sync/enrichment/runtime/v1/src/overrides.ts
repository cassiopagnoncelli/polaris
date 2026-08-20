/**
 * Boot-time loader for per-project enrichment overrides.
 *
 * Reads the OPTIONAL `enrichment:` block from every
 * `definitions/projects/<project_id>.yaml`. Same contract, same failure
 * asymmetry, and the same reasons as the identity stage's loader
 * (`sync/identity/resolver/v1/src/overrides.ts`):
 *
 *   - a MISSING `definitions/` directory is a warning. Local runs and tests
 *     boot from directories that carry no definitions, and manifest defaults
 *     for every project is the right answer there.
 *   - a MALFORMED block fails the boot. The schema is `.strict()`, so a
 *     typo'd key cannot quietly become a limit nobody applied.
 *
 * The two loaders are deliberately not factored into one shared helper.
 * They read different keys into different types, and the ~30 lines they
 * have in common are file-walking boilerplate; a shared "load some block
 * from the catalog" abstraction would have to be generic over the schema
 * and the key, and would earn its keep only at the third caller.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "@polaris/observability-logger";
import {
  type ProjectEnrichmentOverride,
  projectEnrichmentOverrideSchema,
} from "@polaris/governance";
import { parse as parseYaml } from "yaml";

export interface LoadOverridesOptions {
  /** Directory containing `definitions/projects/`. */
  readonly root: string;
  readonly logger: Logger;
}

export function loadProjectEnrichmentOverrides(
  options: LoadOverridesOptions,
): ReadonlyMap<string, ProjectEnrichmentOverride> {
  const projectsDir = join(options.root, "definitions", "projects");
  const overrides = new Map<string, ProjectEnrichmentOverride>();

  if (!existsSync(projectsDir)) {
    options.logger.warn(
      { component: "sync-enrichment.overrides", projects_dir: projectsDir },
      "no definitions/projects directory; every project runs manifest-default enrichment policy",
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
    if (record["enrichment"] === undefined) continue;

    const parsed = projectEnrichmentOverrideSchema.safeParse(record["enrichment"]);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`invalid enrichment block in ${path}: ${issues}`);
    }
    overrides.set(projectId, parsed.data);
  }

  options.logger.info(
    {
      component: "sync-enrichment.overrides",
      projects_dir: projectsDir,
      projects_with_overrides: overrides.size,
      project_ids: [...overrides.keys()],
    },
    "enrichment overrides loaded from catalog",
  );
  return overrides;
}
