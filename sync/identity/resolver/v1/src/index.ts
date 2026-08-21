/**
 * `@polaris/sync-identity-resolver-v1` — the identity stage.
 *
 * The package declared `main: ./dist/index.js` from the day it landed
 * and never emitted one, so its advertised entry point resolved to
 * nothing. Nothing had imported it yet, which is exactly why it went
 * unnoticed — the first consumer (the spine's integration suite) is what
 * turned a dead pointer into a build error.
 *
 * What travels is what this UNIT is: its config, its boot-time override
 * loader, its app builder, its runtime, and the Postgres store behind
 * which all profile-store writes happen. The physics moved out — a
 * caller wanting the resolution rules, the graph, merge semantics or the
 * profile aggregate imports `@polaris/identity-rules`,
 * `@polaris/identity-graph`, `@polaris/identity-merge` or
 * `@polaris/profiles` directly, rather than through a version directory
 * that only ever forwarded them. The runtime internals (`emit`) stay
 * private: they are how this stage does its job, not what another
 * package may depend on.
 */

export { type BuildAppOptions, type BuiltSyncIdentityApp, buildSyncIdentityApp } from "./app.js";
export {
  loadSyncIdentityConfig,
  STAGE_SERVICE_NAME,
  type SyncIdentityConfig,
  type SyncIdentityRuntimeConfig,
  syncIdentityConfigSchema,
  syncIdentityEnvKeys,
} from "./config.js";
export { loadProjectIdentityOverrides } from "./overrides.js";
export { createKyselyProfileRepository } from "./repository.js";
export {
  createRuntime,
  handleEvent,
  type IdentityStageDeps,
  type IdentityStageMetrics,
  type IdentityStageRuntime,
  type IdentityStageRuntimeDeps,
} from "./runtime.js";
