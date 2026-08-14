/**
 * Resolve the enrichment policy for a project.
 *
 * One semantic parameter today: the ceiling on a traits snapshot the
 * spine will carry. It comes from the manifest's declared default, and a
 * project may NARROW it in the `enrichment:` block of
 * `catalog/projects/<id>.yaml` — never widen it past the manifest's
 * bounds. The block's shape is pinned by `@polaris/shared-policy`, the
 * same schema the CLI validates catalog files against.
 *
 * Deploy-time and file-backed, like every semantic parameter: the value
 * that produced a given output is recoverable from a git sha, which is
 * the precondition for a reproducible rebuild.
 */

import type { ProjectEnrichmentOverride } from "@polaris/shared-policy";

export type { ProjectEnrichmentOverride };

/** Manifest-declared defaults. Mirrors `semantic_parameters` exactly. */
export const MANIFEST_DEFAULTS = {
  maxTraitsBytes: 32_768,
} as const;

/** Manifest-declared bounds. A project override outside these is refused. */
export const MANIFEST_BOUNDS = {
  maxTraitsBytes: { min: 1_024, max: 1_048_576 },
} as const;

export class EnrichmentPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EnrichmentPolicyError";
  }
}

/** The effective policy for one project. */
export interface EnrichmentPolicy {
  readonly maxTraitsBytes: number;
}

function checkBounds(
  name: keyof typeof MANIFEST_BOUNDS,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const bounds = MANIFEST_BOUNDS[name];
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    // Refuse rather than clamp: a project asking for a bound the
    // manifest does not allow has a wrong expectation, and quietly
    // substituting a different number hides it until someone audits
    // emitted events.
    throw new EnrichmentPolicyError(
      `${name}=${value} is outside the manifest bounds [${bounds.min}, ${bounds.max}]`,
    );
  }
  return value;
}

export function resolveEnrichmentPolicy(
  overrides: ProjectEnrichmentOverride | undefined,
): EnrichmentPolicy {
  return {
    maxTraitsBytes: checkBounds(
      "maxTraitsBytes",
      overrides?.max_traits_bytes,
      MANIFEST_DEFAULTS.maxTraitsBytes,
    ),
  };
}

/**
 * Per-project policy resolver.
 *
 * Every declared override resolves EAGERLY, at construction: policy is a
 * deploy-time input, so an out-of-bounds value must fail the boot. The
 * alternative — resolving lazily — defers the error to the first message
 * from that project, inside the consumer handler, and cycles the
 * project's whole feed through the retry tiers into the DLQ over a
 * configuration mistake.
 */
export function createPolicyResolver(
  overridesByProject: ReadonlyMap<string, ProjectEnrichmentOverride>,
): (projectId: string, environment: string) => EnrichmentPolicy {
  const cache = new Map<string, EnrichmentPolicy>();
  for (const [projectId, override] of overridesByProject) {
    try {
      cache.set(projectId, resolveEnrichmentPolicy(override));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new EnrichmentPolicyError(
        `project "${projectId}" declares an invalid enrichment override: ${detail}`,
      );
    }
  }

  const defaults = resolveEnrichmentPolicy(undefined);
  return (projectId: string): EnrichmentPolicy => cache.get(projectId) ?? defaults;
}
