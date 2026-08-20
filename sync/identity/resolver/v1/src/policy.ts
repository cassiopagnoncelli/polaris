/**
 * Resolve the identity policy for a project.
 *
 * Semantic parameters come from the manifest's declared defaults; a
 * project may NARROW them — and declare its identifier denylist — in the
 * `identity:` block of `definitions/projects/<id>.yaml`, but never widen
 * them past the manifest's bounds. The block's shape is pinned by
 * `@polaris/governance` so the CLI's catalog validation and this
 * stage's boot loader (`overrides.ts`) cannot drift.
 *
 * These are deploy-time, file-backed inputs — not `project_config`.
 * Changing the cap or the denylist changes which events the stage emits,
 * and semantic truth lives in files and code
 * (`docs/architecture/05-processors-and-replay.md`). It also means the
 * value that produced a given output is recoverable from a git sha,
 * which is what makes a rebuild reproducible.
 */

import type { ProjectIdentityOverride } from "@polaris/governance";

import type { IdentityPolicy, StrongIdentityKind } from "./transform.js";

export type { ProjectIdentityOverride };

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
 * Per-project policy resolver.
 *
 * Every declared override is resolved EAGERLY, at construction: policies
 * are deploy-time inputs, so an out-of-bounds value must fail the boot.
 * Resolving lazily would defer the `IdentityPolicyError` to the first
 * message from that project — inside the consumer handler — and cycle
 * the project's entire feed through the retry tiers into the DLQ, one
 * event at a time, for a configuration mistake.
 *
 * The cache never needs invalidation: a restart is the only way policy
 * changes, which is also what makes "which policy produced this output"
 * answerable from a deployment.
 */
export function createPolicyResolver(
  overridesByProject: ReadonlyMap<string, ProjectIdentityOverride>,
): (projectId: string, environment: string) => IdentityPolicy {
  const cache = new Map<string, IdentityPolicy>();
  for (const [projectId, override] of overridesByProject) {
    try {
      cache.set(projectId, resolveIdentityPolicy(override));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new IdentityPolicyError(
        `project "${projectId}" declares an invalid identity override: ${detail}`,
      );
    }
  }

  const defaults = resolveIdentityPolicy(undefined);
  return (projectId: string): IdentityPolicy => cache.get(projectId) ?? defaults;
}
