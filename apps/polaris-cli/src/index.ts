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
 *   - the command-registration surface that future P6-002+ tasks plug into
 *
 * Business commands (keys, sources, destinations, replays, operators) are
 * intentionally NOT implemented here — each lands in its own task card.
 *
 * @see docs/architecture/02-control-plane.md "Access model"
 * @see docs/implementation/tasks/P6-001-cli-shell.md
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
export { BUILTIN_COMMANDS, versionCommand } from "./commands/index.js";
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
