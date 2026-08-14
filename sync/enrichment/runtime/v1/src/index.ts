/**
 * `@polaris/sync-enrichment-runtime-v1` — the enrichment stage.
 *
 * What travels is the stage's contract: the app builder, the config, the
 * policy resolver, and the pin-set that says which enricher versions
 * this runtime composes. `emit` stays private — envelope construction is
 * how the stage does its job, not a surface for others to build on.
 */

export {
  buildSyncEnrichmentApp,
  type BuildAppOptions,
  type BuiltSyncEnrichmentApp,
} from "./app.js";
export {
  loadSyncEnrichmentConfig,
  STAGE_SERVICE_NAME,
  syncEnrichmentConfigSchema,
  syncEnrichmentEnvKeys,
  type SyncEnrichmentConfig,
  type SyncEnrichmentRuntimeConfig,
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
  EnrichmentPolicyError,
  MANIFEST_BOUNDS,
  MANIFEST_DEFAULTS,
  type EnrichmentPolicy,
  type ProjectEnrichmentOverride,
  resolveEnrichmentPolicy,
} from "./policy.js";
export {
  createRuntime,
  handleEvent,
  type EnrichmentResult,
  type EnrichmentStageDeps,
  type EnrichmentStageMetrics,
  type EnrichmentStageRuntime,
  type EnrichmentStageRuntimeDeps,
} from "./runtime.js";
