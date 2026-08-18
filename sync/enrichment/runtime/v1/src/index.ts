/**
 * `@polaris/sync-enrichment-runtime-v1` — the enrichment stage.
 *
 * What travels is the stage's contract: the app builder, the config, the
 * policy resolver, and the pin-set that says which enricher versions
 * this runtime composes. `emit` stays private — envelope construction is
 * how the stage does its job, not a surface for others to build on.
 */

export {
  type BuildAppOptions,
  type BuiltSyncEnrichmentApp,
  buildSyncEnrichmentApp,
} from "./app.js";
export {
  loadSyncEnrichmentConfig,
  STAGE_SERVICE_NAME,
  type SyncEnrichmentConfig,
  type SyncEnrichmentRuntimeConfig,
  syncEnrichmentConfigSchema,
  syncEnrichmentEnvKeys,
} from "./config.js";
export { loadProjectEnrichmentOverrides } from "./overrides.js";
export {
  ENRICHER_PINS,
  type EnricherPin,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
} from "./pins.js";
export {
  createPolicyResolver,
  type EnrichmentPolicy,
  EnrichmentPolicyError,
  MANIFEST_BOUNDS,
  MANIFEST_DEFAULTS,
  type ProjectEnrichmentOverride,
  resolveEnrichmentPolicy,
} from "./policy.js";
export {
  createRuntime,
  type EnrichmentResult,
  type EnrichmentStageDeps,
  type EnrichmentStageMetrics,
  type EnrichmentStageRuntime,
  type EnrichmentStageRuntimeDeps,
  handleEvent,
} from "./runtime.js";
