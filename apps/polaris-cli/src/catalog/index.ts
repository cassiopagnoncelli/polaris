/**
 * Public surface of the file-backed catalog loader used by `polaris projects`
 * and `polaris sources`.
 */

export { type LoadCatalogOptions, loadCatalog } from "./loader.js";
export {
  type DiscoveredProcessorManifest,
  type LoadOneProcessorManifestOptions,
  type LoadProcessorManifestsOptions,
  loadProcessorManifest,
  loadProcessorManifests,
  PROCESSOR_MODES,
  type ProcessorDefaults,
  type ProcessorManifest,
  type ProcessorManifestScan,
  type ProcessorManifestWarning,
  type ProcessorMode,
  type ProcessorReplay,
  type ProcessorTopicSpec,
  processorDefaultsSchema,
  processorManifestSchema,
  processorModeSchema,
  processorNameSchema,
  processorReplaySchema,
  processorTopicSpecSchema,
  processorVersionSchema,
} from "./processors.js";
export { type ResolveCatalogRootOptions, resolveCatalogRoot } from "./root.js";
export {
  type ProjectDiffRow,
  type ProjectRow,
  type ProjectsSyncPlan,
  planProjectsSync,
  planSourcesSync,
  type SourceDiffRow,
  type SourceRow,
  type SourcesSyncPlan,
  type SyncAction,
} from "./sync.js";
export {
  ENVIRONMENTS,
  type Environment,
  environmentSchema,
  idSchema,
  type LoadedCatalog,
  PROJECT_STATUSES,
  type ProjectFile,
  type ProjectStatus,
  projectFileSchema,
  projectStatusSchema,
  SOURCE_RUNTIMES,
  SOURCE_STATUSES,
  SOURCE_TYPES,
  type SourceFile,
  type SourceRuntime,
  type SourceStatus,
  type SourceType,
  sourceFileSchema,
  sourceRuntimeSchema,
  sourceStatusSchema,
  sourceTypeSchema,
} from "./types.js";
