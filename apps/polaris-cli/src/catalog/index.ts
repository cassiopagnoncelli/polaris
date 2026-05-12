/**
 * Public surface of the file-backed catalog loader used by `polaris projects`
 * and `polaris sources`.
 */
export {
  ENVIRONMENTS,
  environmentSchema,
  idSchema,
  PROJECT_STATUSES,
  projectFileSchema,
  projectStatusSchema,
  SOURCE_RUNTIMES,
  SOURCE_STATUSES,
  SOURCE_TYPES,
  sourceFileSchema,
  sourceRuntimeSchema,
  sourceStatusSchema,
  sourceTypeSchema,
  type Environment,
  type LoadedCatalog,
  type ProjectFile,
  type ProjectStatus,
  type SourceFile,
  type SourceRuntime,
  type SourceStatus,
  type SourceType,
} from "./types.js";
export { type LoadCatalogOptions, loadCatalog } from "./loader.js";
export { type ResolveCatalogRootOptions, resolveCatalogRoot } from "./root.js";
export {
  planProjectsSync,
  planSourcesSync,
  type ProjectDiffRow,
  type ProjectRow,
  type ProjectsSyncPlan,
  type SourceDiffRow,
  type SourceRow,
  type SourcesSyncPlan,
  type SyncAction,
} from "./sync.js";
