/**
 * Public shapes for the project-config read store.
 *
 * @see docs/implementation/project-config-plan.md §3.5
 */

import type { PolarisEnvironment } from "@polaris/runtime-environments";

/** The scope a component reads: one namespace within one project+environment. */
export interface ProjectConfigKey {
  readonly projectId: string;
  readonly environment: PolarisEnvironment;
  /** The reading component, e.g. `meta-capi`, `sessionizer`, `ingest`. */
  readonly namespace: string;
}

/**
 * One namespace's stored values for one `(project, environment)`.
 *
 * Deliberately RAW: no schema parsing and no defaults applied. The component
 * owns its schema and parses its own slice — in strip mode, never `.strict()`,
 * so keys it does not declare stay inert rather than quarantining the project.
 *
 * Secret-flagged rows arrive as {@link import("./secret-box.js").Secret}
 * instances, so {@link toJSON} — and therefore anything that serializes this
 * object — redacts by construction.
 */
export interface ProjectConfigSnapshot {
  readonly projectId: string;
  readonly environment: PolarisEnvironment;
  readonly namespace: string;
  /** `project_config_versions.version` at assembly; `0n` when no row existed. */
  readonly version: bigint;
  readonly values: Readonly<Record<string, unknown>>;
  /** Epoch ms at assembly, from the store's injected clock. */
  readonly resolvedAt: number;
  /** Redacts secret values. `JSON.stringify(snapshot)` is safe. */
  toJSON(): unknown;
}

/**
 * Snapshots held for the lifetime of one batch.
 *
 * Config resolves once per batch rather than per event, so a batch cannot
 * straddle two versions: an invalidation arriving mid-batch affects the next
 * batch, not this one.
 */
export interface PinnedConfig {
  /**
   * @throws {import("./errors.js").PinMissingError} when the key was not part
   *   of the `pin()` call.
   */
  snapshot(key: ProjectConfigKey): ProjectConfigSnapshot;
}
