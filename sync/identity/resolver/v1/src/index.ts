/**
 * `@polaris/sync-identity-resolver-v1` — the identity stage.
 *
 * The package declared `main: ./dist/index.js` from the day it landed
 * and never emitted one, so its advertised entry point resolved to
 * nothing. Nothing had imported it yet, which is exactly why it went
 * unnoticed — the first consumer (the spine's integration suite) is what
 * turned a dead pointer into a build error.
 *
 * What travels is the stage's contract: the repository behind which all
 * profile-store writes happen, the policy resolver, and the app builder.
 * The runtime internals (`emit`, `transform`) stay private — they are
 * how this stage does its job, not what another package may depend on.
 */

export { buildSyncIdentityApp, type BuildAppOptions, type BuiltSyncIdentityApp } from "./app.js";
export {
  loadSyncIdentityConfig,
  STAGE_SERVICE_NAME,
  syncIdentityConfigSchema,
  syncIdentityEnvKeys,
  type SyncIdentityConfig,
  type SyncIdentityRuntimeConfig,
} from "./config.js";
export {
  createPolicyResolver,
  IdentityPolicyError,
  MANIFEST_BOUNDS,
  MANIFEST_DEFAULTS,
  type ProjectIdentityOverride,
  resolveIdentityPolicy,
} from "./policy.js";
export { loadProjectIdentityOverrides } from "./overrides.js";
export {
  type BoundIdentifier,
  createKyselyProfileRepository,
  type MergeOutcome,
  type ProfileRepository,
  type RejectedIdentifier,
  type ResolutionKind,
  type ResolutionResult,
  type ResolveInput,
} from "./repository.js";
export {
  createRuntime,
  handleEvent,
  type IdentityStageDeps,
  type IdentityStageMetrics,
  type IdentityStageRuntime,
  type IdentityStageRuntimeDeps,
} from "./runtime.js";
export type { IdentityPolicy, StrongIdentityKind } from "./transform.js";
