/**
 * `@polaris/polaris-cli` — control-plane CLI shell.
 *
 * The CLI is a thin client over the Polaris control-plane API
 * (`apps/control-plane-api/`). This package owns:
 *
 *   - argv parsing (commander) and global flag surface
 *   - config loading (env vars + optional ~/.polaris/config.toml profiles)
 *   - bearer-token resolution via the env var the active profile points at —
 *     tokens are NEVER stored in the config file or anywhere on disk
 *   - logger wiring through `@polaris/shared-logger` (stderr-only, baked-in
 *     secret redaction)
 *   - output streams and `human` / `json` rendering
 *   - the `polaris version` built-in command
 *   - `polaris projects` / `polaris sources` (P6-002) — file-backed
 *     declarations materialized into PostgreSQL
 *   - the command-registration surface that future P6-002+ tasks plug into
 *
 * Other business commands (keys, destinations, processors, replays,
 * operators) land in their own task cards.
 *
 * @see docs/architecture/02-control-plane.md "Access model", "Projects and Environments", "Sources"
 * @see docs/implementation/tasks/P6-001-cli-shell.md
 * @see docs/implementation/tasks/P6-002-projects-sources-cli.md
 */

export type {
  CommandContext,
  CommandDefinition,
  CommandHandler,
  CommandRegistrarDeps,
  CommandResult,
} from "./command.js";
export {
  type CliConfig,
  type CliLogLevel,
  CLI_LOG_LEVELS,
  DEFAULT_CONFIG_PATH,
  loadCliConfig,
  type LoadConfigOptions,
  type OutputFormat,
  OUTPUT_FORMATS,
  type ProfileEntry,
  readConfigFile,
} from "./config.js";
export {
  auditCommand,
  BUILTIN_COMMANDS,
  destinationsCommand,
  exportCommand,
  keysCommand,
  processorsCommand,
  projectsCommand,
  sourcesCommand,
  versionCommand,
} from "./commands/index.js";
export { auditListCommand, auditShowCommand } from "./commands/audit/index.js";
export {
  buildAuditListRunner,
  type AuditListHooks,
  type AuditListStore,
} from "./commands/audit/list.js";
export {
  buildAuditShowRunner,
  type AuditShowHooks,
  type AuditShowStore,
} from "./commands/audit/show.js";
export {
  exportApiKeysCommand,
  exportAuditCommand,
  exportDestinationsCommand,
  exportSourcesCommand,
} from "./commands/export/index.js";
export {
  buildExportApiKeysRunner,
  type ExportApiKeysHooks,
  type ExportApiKeysStore,
} from "./commands/export/api-keys.js";
export {
  buildExportAuditRunner,
  type ExportAuditHooks,
  type ExportAuditStore,
} from "./commands/export/audit.js";
export {
  buildExportDestinationsRunner,
  type ExportDestinationsHooks,
  type ExportDestinationsStore,
} from "./commands/export/destinations.js";
export {
  buildExportSourcesRunner,
  type ExportSourcesHooks,
  type ExportSourcesStore,
} from "./commands/export/sources.js";
export {
  type AuditRecorder,
  type CreateRecorderOptions,
  createAuditRecorder,
  readAuditRecord,
  type RecordAuditInput,
} from "./audit/recorder.js";
export {
  destinationsCreateCommand,
  destinationsDisableCommand,
  destinationsEnableCommand,
  destinationsListCommand,
  destinationsShowCommand,
  destinationsUpdateOpsCommand,
} from "./commands/destinations/index.js";
export {
  processorsDisableCommand,
  processorsEnableCommand,
  processorsListCommand,
  processorsRunsCommand,
  processorsRunsListCommand,
  processorsRunsShowCommand,
  processorsShowCommand,
} from "./commands/processors/index.js";
export {
  buildProcessorsListRunner,
  type ProcessorsListHooks,
  type ProcessorsListStore,
} from "./commands/processors/list.js";
export {
  buildProcessorsShowRunner,
  type ProcessorsShowHooks,
  type ProcessorsShowStore,
} from "./commands/processors/show.js";
export {
  buildProcessorsEnableRunner,
  type ProcessorsEnableHooks,
  type ProcessorsEnableStore,
} from "./commands/processors/enable.js";
export {
  buildProcessorsDisableRunner,
  type ProcessorsDisableHooks,
  type ProcessorsDisableStore,
} from "./commands/processors/disable.js";
export {
  buildProcessorsRunsListRunner,
  type ProcessorRunListRow,
  type ProcessorsRunsListHooks,
  type ProcessorsRunsListStore,
} from "./commands/processors/runs-list.js";
export {
  buildProcessorsRunsShowRunner,
  type ProcessorRunDetail,
  type ProcessorsRunsShowHooks,
  type ProcessorsRunsShowStore,
} from "./commands/processors/runs-show.js";
export {
  FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS,
  rejectProcessorRuleArguments,
} from "./commands/processors/validation.js";
export {
  buildDestinationsCreateRunner,
  type DestinationsCreateHooks,
  type DestinationsCreateStore,
} from "./commands/destinations/create.js";
export {
  buildDestinationsDisableRunner,
  type DestinationsDisableHooks,
  type DestinationsDisableStore,
} from "./commands/destinations/disable.js";
export {
  buildDestinationsEnableRunner,
  type DestinationsEnableHooks,
  type DestinationsEnableStore,
} from "./commands/destinations/enable.js";
export {
  buildDestinationsListRunner,
  type DestinationsListHooks,
  type DestinationsListStore,
} from "./commands/destinations/list.js";
export {
  buildDestinationsShowRunner,
  type DestinationsShowHooks,
  type DestinationsShowStore,
} from "./commands/destinations/show.js";
export {
  buildDestinationsUpdateOpsRunner,
  type DestinationsUpdateOpsHooks,
  type DestinationsUpdateOpsStore,
} from "./commands/destinations/update-ops.js";
export {
  DESTINATION_ID_PREFIX,
  generateDestinationId,
} from "./commands/destinations/id.js";
export {
  FORBIDDEN_MAPPING_FLAG_TOKENS,
  rejectMappingArguments,
  validateSecretRef,
} from "./commands/destinations/validation.js";
export {
  keysCreateCommand,
  keysListCommand,
  keysRevokeCommand,
  keysRotateCommand,
} from "./commands/keys/index.js";
export {
  buildKeysCreateRunner,
  type KeysCreateHooks,
  type KeysCreateStore,
} from "./commands/keys/create.js";
export {
  buildKeysListRunner,
  type KeysListHooks,
  type KeysListStore,
} from "./commands/keys/list.js";
export {
  buildKeysRevokeRunner,
  type KeysRevokeHooks,
  type KeysRevokeStore,
} from "./commands/keys/revoke.js";
export {
  buildKeysRotateRunner,
  type KeysRotateHooks,
  type KeysRotateStore,
  type RotateStoreInput,
} from "./commands/keys/rotate.js";
export {
  formatToken,
  generateKeyMaterial,
  type IssuedKeyMaterial,
} from "./commands/keys/token.js";
export {
  projectsListCommand,
  projectsShowCommand,
  projectsSyncCommand,
} from "./commands/projects/index.js";
export {
  sourcesListCommand,
  sourcesShowCommand,
  sourcesSyncCommand,
} from "./commands/sources/index.js";
export {
  type DiscoveredProcessorManifest,
  ENVIRONMENTS,
  environmentSchema,
  idSchema,
  loadCatalog,
  type LoadCatalogOptions,
  type LoadedCatalog,
  type LoadOneProcessorManifestOptions,
  type LoadProcessorManifestsOptions,
  loadProcessorManifest,
  loadProcessorManifests,
  planProjectsSync,
  planSourcesSync,
  PROCESSOR_MODES,
  type ProcessorDefaults,
  processorDefaultsSchema,
  type ProcessorManifest,
  type ProcessorManifestScan,
  type ProcessorManifestWarning,
  processorManifestSchema,
  type ProcessorMode,
  processorModeSchema,
  processorNameSchema,
  type ProcessorReplay,
  processorReplaySchema,
  type ProcessorTopicSpec,
  processorTopicSpecSchema,
  processorVersionSchema,
  PROJECT_STATUSES,
  type ProjectDiffRow,
  type ProjectFile,
  projectFileSchema,
  type ProjectRow,
  type ProjectStatus,
  projectStatusSchema,
  type ProjectsSyncPlan,
  resolveCatalogRoot,
  type ResolveCatalogRootOptions,
  SOURCE_RUNTIMES,
  SOURCE_STATUSES,
  SOURCE_TYPES,
  type SourceDiffRow,
  type SourceFile,
  sourceFileSchema,
  type SourceRow,
  type SourceRuntime,
  sourceRuntimeSchema,
  type SourcesSyncPlan,
  type SourceStatus,
  sourceStatusSchema,
  type SourceType,
  sourceTypeSchema,
  type SyncAction,
  type Environment,
} from "./catalog/index.js";
export {
  type ApiKeyRow,
  AUDIT_ACTOR_SOURCES,
  AUDIT_ENVIRONMENTS,
  type AuditActorSource,
  type AuditEnvironment,
  type AuditRecordRow,
  type AuditRecordsTable,
  connectDb,
  type ConnectDbOptions,
  type DbHandle,
  disableDestination,
  disableProcessorActivation,
  type DisableProcessorActivationInput,
  enableDestination,
  enableProcessorActivation,
  type EnableProcessorActivationInput,
  type DestinationRow,
  findActivationByKey,
  findApiKeyById,
  findAuditRecordById,
  findDestinationById,
  insertApiKey,
  insertAuditRecord,
  insertDestination,
  type InsertApiKeyInput,
  type InsertAuditRecordInput,
  type InsertDestinationInput,
  listActivationsForProcessor,
  listAllActivations,
  listAllDestinations,
  listApiKeysByProjectEnv,
  listAuditRecords,
  listDestinationsByProjectEnv,
  type ListAuditRecordsFilter,
  type ProcessorActivationKey,
  type ProcessorActivationRow,
  revokeApiKey,
  updateDestinationOps,
  type UpdateDestinationOpsInput,
} from "./db/index.js";
export {
  AuthError,
  CliError,
  ConfigError,
  ExitCode,
  isCliError,
  NotImplementedError,
  UsageError,
} from "./errors.js";
export { createCliLogger } from "./logger.js";
export {
  createOutputStreams,
  type OutputStreams,
  renderAccordingTo,
  renderHuman,
  renderJson,
} from "./output.js";
export { type PackageMeta, resolvePackageMeta } from "./package-meta.js";
export { buildProgram, run, type RunOptions } from "./program.js";
