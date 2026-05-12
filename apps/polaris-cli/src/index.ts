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
  BUILTIN_COMMANDS,
  projectsCommand,
  sourcesCommand,
  versionCommand,
} from "./commands/index.js";
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
  ENVIRONMENTS,
  environmentSchema,
  idSchema,
  loadCatalog,
  type LoadCatalogOptions,
  type LoadedCatalog,
  planProjectsSync,
  planSourcesSync,
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
export { connectDb, type ConnectDbOptions, type DbHandle } from "./db/index.js";
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
