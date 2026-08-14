/**
 * Resolve the identity policy for a project.
 *
 * Semantic parameters come from the manifest's declared defaults; a
 * project may NARROW them in `catalog/projects/<id>.yaml` but never widen
 * them past the manifest's bounds. The identifier denylist comes from
 * `catalog/policy/`, the same file-backed home the forbidden-field policy
 * uses.
 *
 * Both are deploy-time, file-backed inputs — not `project_config`.
 * Changing the cap or the denylist changes which events the stage emits,
 * and semantic truth lives in files and code
 * (`docs/architecture/05-processors-and-replay.md`). It also means the
 * value that produced a given output is recoverable from a git sha,
 * which is what makes a rebuild reproducible.
 */

import type { IdentityPolicy, StrongIdentityKind } from "./transform.js";

/** Manifest-declared defaults. Mirrors `semantic_parameters` exactly. */
export const MANIFEST_DEFAULTS = {
  maxIdentifiersPerKind: 100,
  maxMergesPerWindow: 50,
  mergeWindowSeconds: 3600,
  maxTraitsBytes: 32768,
} as const;

/** Manifest-declared bounds. A project override outside these is refused. */
export const MANIFEST_BOUNDS = {
  maxIdentifiersPerKind: { min: 1, max: 10_000 },
  maxMergesPerWindow: { min: 1, max: 100_000 },
  mergeWindowSeconds: { min: 60, max: 86_400 },
  maxTraitsBytes: { min: 1_024, max: 1_048_576 },
} as const;

/** Shape a project may declare under `identity:` in its catalog file. */
export interface ProjectIdentityOverride {
  readonly max_identifiers_per_kind?: number;
  readonly max_merges_per_window?: number;
  readonly merge_window_seconds?: number;
  readonly max_traits_bytes?: number;
  /** Identifier values that resolve as if absent, keyed by kind. */
  readonly denylist?: Partial<Record<StrongIdentityKind, readonly string[]>>;
}

export class IdentityPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IdentityPolicyError";
  }
}

function clampToBounds(
  name: keyof typeof MANIFEST_BOUNDS,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const bounds = MANIFEST_BOUNDS[name];
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    // Refuse rather than clamp silently: a project asking for a bound the
    // manifest does not allow has a wrong expectation, and quietly giving
    // it a different number would hide that until someone audited emitted
    // events.
    throw new IdentityPolicyError(
      `${name}=${value} is outside the manifest bounds [${bounds.min}, ${bounds.max}]`,
    );
  }
  return value;
}

/**
 * Build the effective policy for one project.
 *
 * `overrides` is the project's `identity:` block, if it declared one.
 * Absent means manifest defaults, which is the correct behaviour for
 * every project that has not thought about identity bounds yet.
 */
export function resolveIdentityPolicy(
  overrides: ProjectIdentityOverride | undefined,
): IdentityPolicy {
  const denylist: Partial<Record<StrongIdentityKind, ReadonlySet<string>>> = {};
  for (const [kind, values] of Object.entries(overrides?.denylist ?? {})) {
    if (values !== undefined && values.length > 0) {
      denylist[kind as StrongIdentityKind] = new Set(values);
    }
  }

  return {
    denylist,
    maxIdentifiersPerKind: clampToBounds(
      "maxIdentifiersPerKind",
      overrides?.max_identifiers_per_kind,
      MANIFEST_DEFAULTS.maxIdentifiersPerKind,
    ),
    maxMergesPerWindow: clampToBounds(
      "maxMergesPerWindow",
      overrides?.max_merges_per_window,
      MANIFEST_DEFAULTS.maxMergesPerWindow,
    ),
    mergeWindowSeconds: clampToBounds(
      "mergeWindowSeconds",
      overrides?.merge_window_seconds,
      MANIFEST_DEFAULTS.mergeWindowSeconds,
    ),
    maxTraitsBytes: clampToBounds(
      "maxTraitsBytes",
      overrides?.max_traits_bytes,
      MANIFEST_DEFAULTS.maxTraitsBytes,
    ),
  };
}

/**
 * Per-project policy resolver with a small cache.
 *
 * Policies are deploy-time inputs, so they cannot change under a running
 * process — the cache is unbounded-by-project on purpose and never needs
 * invalidation. A restart is the only way policy changes, which is also
 * what makes "which policy produced this output" answerable from a
 * deployment.
 */
export function createPolicyResolver(
  overridesByProject: ReadonlyMap<string, ProjectIdentityOverride>,
): (projectId: string, environment: string) => IdentityPolicy {
  const cache = new Map<string, IdentityPolicy>();
  return (projectId: string): IdentityPolicy => {
    const cached = cache.get(projectId);
    if (cached !== undefined) return cached;
    const resolved = resolveIdentityPolicy(overridesByProject.get(projectId));
    cache.set(projectId, resolved);
    return resolved;
  };
}
