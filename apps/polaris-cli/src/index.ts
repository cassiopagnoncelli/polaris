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

export {
  type DiscoveredProcessorManifest,
  ENVIRONMENTS,
  type Environment,
  environmentSchema,
  idSchema,
  type LoadCatalogOptions,
  type LoadedCatalog,
  type LoadOneProcessorManifestOptions,
  type LoadProcessorManifestsOptions,
  loadCatalog,
  loadProcessorManifest,
  loadProcessorManifests,
  PROCESSOR_MODES,
  PROJECT_STATUSES,
  type ProcessorDefaults,
  type ProcessorManifest,
  type ProcessorManifestScan,
  type ProcessorManifestWarning,
  type ProcessorMode,
  type ProcessorReplay,
  type ProcessorTopicSpec,
  type ProjectDiffRow,
  type ProjectFile,
  type ProjectRow,
  type ProjectStatus,
  type ProjectsSyncPlan,
  planProjectsSync,
  planSourcesSync,
  processorDefaultsSchema,
  processorManifestSchema,
  processorModeSchema,
  processorNameSchema,
  processorReplaySchema,
  processorTopicSpecSchema,
  processorVersionSchema,
  projectFileSchema,
  projectStatusSchema,
  type ResolveCatalogRootOptions,
  resolveCatalogRoot,
  SOURCE_RUNTIMES,
  SOURCE_STATUSES,
  SOURCE_TYPES,
  type SourceDiffRow,
  type SourceFile,
  type SourceRow,
  type SourceRuntime,
  type SourceStatus,
  type SourcesSyncPlan,
  type SourceType,
  type SyncAction,
  sourceFileSchema,
  sourceRuntimeSchema,
  sourceStatusSchema,
  sourceTypeSchema,
} from "./catalog/index.js";
export type {
  CommandContext,
  CommandDefinition,
  CommandHandler,
  CommandRegistrarDeps,
  CommandResult,
} from "./command.js";
export { auditListCommand, auditShowCommand } from "./commands/audit/index.js";
export {
  type AuditListHooks,
  type AuditListStore,
  buildAuditListRunner,
} from "./commands/audit/list.js";
export {
  type AuditShowHooks,
  type AuditShowStore,
  buildAuditShowRunner,
} from "./commands/audit/show.js";
export {
  buildClickhouseRebuildAbortRunner,
  type ClickhouseRebuildAbortHooks,
  type ClickhouseRebuildAbortOutcome,
  type ClickhouseRebuildAbortStore,
  type ClickhouseRebuildAbortStoreInput,
} from "./commands/clickhouse-rebuild/abort.js";
export {
  buildClickhouseRebuildCreateRunner,
  type ClickhouseRebuildCreateAuditPayload,
  type ClickhouseRebuildCreateHooks,
  type ClickhouseRebuildCreateStore,
  type ClickhouseRebuildDriverHandle,
  type ClickhouseRebuildExecutorStoreHandle,
  type ClickhouseRebuildJobAuditSnapshot,
} from "./commands/clickhouse-rebuild/create.js";
export {
  CLICKHOUSE_REBUILD_JOB_ID_PREFIX,
  generateClickhouseRebuildJobId,
} from "./commands/clickhouse-rebuild/id.js";
export {
  clickhouseRebuildAbortCommand,
  clickhouseRebuildCreateCommand,
  clickhouseRebuildListCommand,
  clickhouseRebuildPlanCommand,
  clickhouseRebuildShowCommand,
} from "./commands/clickhouse-rebuild/index.js";
export {
  buildClickhouseRebuildListRunner,
  type ClickhouseRebuildListHooks,
  type ClickhouseRebuildListStore,
} from "./commands/clickhouse-rebuild/list.js";
export {
  buildClickhouseRebuildPlanRunner,
  type ClickhouseRebuildPlanHooks,
} from "./commands/clickhouse-rebuild/plan.js";
export {
  buildClickhouseRebuildShowRunner,
  type ClickhouseRebuildShowHooks,
  type ClickhouseRebuildShowStore,
} from "./commands/clickhouse-rebuild/show.js";
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
  buildDestinationsDisableReplayRunner,
  type DestinationsDisableReplayAuditPayload,
  type DestinationsDisableReplayHooks,
  type DestinationsDisableReplayStore,
} from "./commands/destinations/disable-replay.js";
export {
  buildDestinationsEnableRunner,
  type DestinationsEnableHooks,
  type DestinationsEnableStore,
} from "./commands/destinations/enable.js";
export {
  buildDestinationsEnableReplayRunner,
  type DestinationReplayAuditSnapshot,
  type DestinationsEnableReplayAuditPayload,
  type DestinationsEnableReplayHooks,
  type DestinationsEnableReplayStore,
} from "./commands/destinations/enable-replay.js";
export {
  DESTINATION_ID_PREFIX,
  generateDestinationId,
} from "./commands/destinations/id.js";
export {
  destinationsCreateCommand,
  destinationsDisableCommand,
  destinationsDisableReplayCommand,
  destinationsEnableCommand,
  destinationsEnableReplayCommand,
  destinationsListCommand,
  destinationsShowCommand,
  destinationsUpdateOpsCommand,
} from "./commands/destinations/index.js";
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
  FORBIDDEN_MAPPING_FLAG_TOKENS,
  rejectMappingArguments,
  validateSecretRef,
} from "./commands/destinations/validation.js";
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
  exportApiKeysCommand,
  exportAuditCommand,
  exportDestinationsCommand,
  exportSourcesCommand,
} from "./commands/export/index.js";
export {
  buildExportSourcesRunner,
  type ExportSourcesHooks,
  type ExportSourcesStore,
} from "./commands/export/sources.js";
export {
  auditCommand,
  BUILTIN_COMMANDS,
  clickhouseRebuildCommand,
  destinationsCommand,
  exportCommand,
  keysCommand,
  operatorsCommand,
  processorsCommand,
  projectsCommand,
  sourcesCommand,
  topicsCommand,
  versionCommand,
} from "./commands/index.js";
export {
  buildKeysCreateRunner,
  type KeysCreateHooks,
  type KeysCreateStore,
} from "./commands/keys/create.js";
export {
  keysCreateCommand,
  keysListCommand,
  keysRevokeCommand,
  keysRotateCommand,
} from "./commands/keys/index.js";
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
  buildOperatorsCreateRunner,
  type OperatorsCreateAuditPayload,
  type OperatorsCreateHooks,
  type OperatorsCreateStore,
  type OperatorTokenAuditSnapshot,
} from "./commands/operators/create.js";
export {
  operatorsCreateCommand,
  operatorsListCommand,
  operatorsRevokeCommand,
} from "./commands/operators/index.js";
export {
  buildOperatorsListRunner,
  type OperatorsListHooks,
  type OperatorsListStore,
} from "./commands/operators/list.js";
export {
  buildOperatorsRevokeRunner,
  type OperatorsRevokeAuditPayload,
  type OperatorsRevokeHooks,
  type OperatorsRevokeStore,
} from "./commands/operators/revoke.js";
export {
  buildProcessorsDisableRunner,
  type ProcessorsDisableHooks,
  type ProcessorsDisableStore,
} from "./commands/processors/disable.js";
export {
  buildProcessorsEnableRunner,
  type ProcessorsEnableHooks,
  type ProcessorsEnableStore,
} from "./commands/processors/enable.js";
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
  buildProcessorsShowRunner,
  type ProcessorsShowHooks,
  type ProcessorsShowStore,
} from "./commands/processors/show.js";
export {
  FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS,
  rejectProcessorRuleArguments,
} from "./commands/processors/validation.js";
export {
  projectsListCommand,
  projectsShowCommand,
  projectsSyncCommand,
} from "./commands/projects/index.js";
export {
  buildReplayCancelRunner,
  type ReplayCancelHooks,
  type ReplayCancelOutcome,
  type ReplayCancelStore,
  type ReplayCancelStoreInput,
} from "./commands/replay/cancel.js";
export {
  buildReplayCreateRunner,
  type ReplayCreateAuditPayload,
  type ReplayCreateHooks,
  type ReplayCreateStore,
  type ReplayJobAuditSnapshot,
} from "./commands/replay/create.js";
export {
  buildReplayExecuteRunner,
  type ReplayExecuteHooks,
  type ReplayExecuteStore,
} from "./commands/replay/execute.js";
export {
  replayCancelCommand,
  replayCommand,
  replayCreateCommand,
  replayExecuteCommand,
  replayListCommand,
  replayPauseCommand,
  replayPlanCommand,
  replayResumeCommand,
  replayShowCommand,
} from "./commands/replay/index.js";
export {
  buildReplayListRunner,
  type ReplayListHooks,
  type ReplayListStore,
} from "./commands/replay/list.js";
export {
  buildReplayPauseRunner,
  type ReplayPauseHooks,
  type ReplayPauseOutcome,
  type ReplayPauseStore,
  type ReplayPauseStoreInput,
} from "./commands/replay/pause.js";
export {
  buildReplayPlanRunner,
  type ReplayPlanHooks,
  type ReplayPlanStore,
} from "./commands/replay/plan.js";
export {
  buildReplayResumeRunner,
  type ReplayResumeHooks,
  type ReplayResumeOutcome,
  type ReplayResumeStore,
  type ReplayResumeStoreInput,
} from "./commands/replay/resume.js";
export {
  buildReplayShowRunner,
  type ReplayShowHooks,
  type ReplayShowStore,
} from "./commands/replay/show.js";
export {
  FORBIDDEN_REPLAY_PLAN_FLAG_TOKENS,
  rejectReplayPlanArguments,
} from "./commands/replay/validation.js";
export {
  sourcesListCommand,
  sourcesShowCommand,
  sourcesSyncCommand,
} from "./commands/sources/index.js";
export {
  buildTopicsDeisolateRunner,
  type TopicIsolationDeisolateSnapshot,
  type TopicsDeisolateAuditPayload,
  type TopicsDeisolateHooks,
  type TopicsDeisolateStore,
} from "./commands/topics/deisolate.js";
export {
  topicsDeisolateCommand,
  topicsIsolateCommand,
  topicsListCommand,
} from "./commands/topics/index.js";
export {
  buildTopicsIsolateRunner,
  type IsolateInsertOutcome,
  TOPIC_ISOLATION_ID_PREFIX,
  type TopicIsolationAuditSnapshot,
  type TopicsIsolateAuditPayload,
  type TopicsIsolateHooks,
  type TopicsIsolateStore,
} from "./commands/topics/isolate.js";
export {
  buildTopicsListRunner,
  type TopicsListFilter,
  type TopicsListHooks,
  type TopicsListStore,
} from "./commands/topics/list.js";
export {
  type AuthenticatedCliConfig,
  CLI_LOG_LEVELS,
  type CliConfig,
  type CliLogLevel,
  DEFAULT_CONFIG_PATH,
  type LoadConfigOptions,
  loadCliConfig,
  OUTPUT_FORMATS,
  type OutputFormat,
  type ProfileEntry,
  readConfigFile,
  requireHttpAuth,
} from "./config.js";
export {
  ABORTABLE_CLICKHOUSE_REBUILD_JOB_STATUSES,
  type ApiKeyRow,
  AUDIT_ACTOR_SOURCES,
  AUDIT_ENVIRONMENTS,
  type AuditActorSource,
  type AuditEnvironment,
  type AuditRecordRow,
  type AuditRecordsTable,
  CLICKHOUSE_REBUILD_JOB_STATUSES,
  type ClickhouseRebuildJobRow,
  type ClickhouseRebuildJobStatus,
  type ClickhouseRebuildJobsTable,
  type ConnectDbOptions,
  connectDb,
  type DbHandle,
  type DestinationRow,
  type DisableProcessorActivationInput,
  type EnableProcessorActivationInput,
  findActivationByKey,
  findApiKeyById,
  findAuditRecordById,
  findClickhouseRebuildJobById,
  findDestinationById,
  findOperatorTokenAuthRowById,
  findOperatorTokenById,
  type InsertApiKeyInput,
  type InsertClickhouseRebuildJobInput,
  type InsertDestinationInput,
  type InsertOperatorTokenInput,
  isAbortableClickhouseRebuildStatus,
  isTerminalClickhouseRebuildStatus,
  type ListAuditRecordsFilter,
  type ListClickhouseRebuildJobsFilter,
  listActivationsForProcessor,
  listAllActivations,
  listAllDestinations,
  listApiKeysByProjectEnv,
  listAuditRecords,
  listClickhouseRebuildJobs,
  listDestinationsByProjectEnv,
  listOperatorTokens,
  OPERATOR_TOKEN_STATUSES,
  type OperatorTokenAuthRow,
  type OperatorTokenRow,
  type OperatorTokenStatus,
  type OperatorTokensTable,
  type ProcessorActivationKey,
  type ProcessorActivationRow,
  TERMINAL_CLICKHOUSE_REBUILD_JOB_STATUSES,
  touchOperatorTokenLastUsedAt,
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
export { createKyselyOperatorTokenRepository } from "./operators/repository.js";
export {
  generateOperatorTokenMaterial,
  type IssuedOperatorTokenMaterial,
} from "./operators/token-material.js";
export {
  createOutputStreams,
  type OutputStreams,
  renderAccordingTo,
  renderHuman,
  renderJson,
} from "./output.js";
export { type PackageMeta, resolvePackageMeta } from "./package-meta.js";
export { buildProgram, type RunOptions, run } from "./program.js";
