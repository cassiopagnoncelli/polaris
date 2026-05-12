import { Command, Option } from "commander";
import type {
  CommandContext,
  CommandDefinition,
  CommandHandler,
  CommandRegistrarDeps,
} from "./command.js";
import {
  CLI_LOG_LEVELS,
  type CliLogLevel,
  loadCliConfig,
  type OutputFormat,
  OUTPUT_FORMATS,
} from "./config.js";
import { BUILTIN_COMMANDS } from "./commands/index.js";
import { CliError, ExitCode, isCliError, UsageError } from "./errors.js";
import { createCliLogger } from "./logger.js";
import { createOutputStreams, type OutputStreams, renderJson } from "./output.js";
import { type PackageMeta, resolvePackageMeta } from "./package-meta.js";

/**
 * Wiring needed to run the CLI once.
 *
 * The shell separates "build the program" from "execute it" so tests can:
 *
 *   - construct a program with a synthetic env / streams pair,
 *   - parse a fixed argv,
 *   - assert on output without touching real fds or `process.exit`.
 */
export interface RunOptions {
  /** argv array WITHOUT the leading `node` / script path entries. */
  readonly argv: readonly string[];
  /** Process env. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** stdout/stderr sinks. Defaults wrap the real process streams. */
  readonly output?: OutputStreams;
  /** Override commands registered with the program. Defaults to built-ins. */
  readonly commands?: readonly CommandDefinition[];
  /** Override CLI package meta (tests pin git sha / build time). */
  readonly meta?: PackageMeta;
}

/**
 * Execute the CLI and resolve to the exit code the process should use.
 *
 * Never calls `process.exit` itself — the binary entry point in
 * `bin/polaris.ts` handles that. Returning a code keeps unit tests free of
 * `process.exit` mocking.
 */
export async function run(options: RunOptions): Promise<ExitCode> {
  const env = options.env ?? process.env;
  const output = options.output ?? createOutputStreams();
  const meta = options.meta ?? resolvePackageMeta(env);
  const commands = options.commands ?? BUILTIN_COMMANDS;

  const program = buildProgram({ env, output, meta, commands });
  // commander reads `program.exitOverride()` to throw instead of `process.exit`
  // on parse failures; we already do that in `buildProgram`. Wrap the parse
  // call to map commander's exit-override errors to our `ExitCode` values.
  try {
    await program.parseAsync(options.argv as string[], { from: "user" });
    return ExitCode.Ok;
  } catch (error: unknown) {
    return handleTopLevelError(error, { output, env });
  }
}

interface BuildOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly output: OutputStreams;
  readonly meta: PackageMeta;
  readonly commands: readonly CommandDefinition[];
}

/**
 * Construct the commander program with all global flags and commands wired in.
 *
 * Exported for tests that want to inspect the help text or simulate parse
 * errors without going through `run`.
 */
export function buildProgram(options: BuildOptions): Command {
  const { env, output, meta, commands } = options;
  const program = new Command();

  program
    .name("polaris")
    .description(
      [
        "Polaris control-plane CLI — thin client for the control-plane API.",
        "",
        "Authentication: bash-invocable, no interactive login. Set two env vars:",
        "  POLARIS_API_URL  base URL of the control-plane API",
        "  POLARIS_TOKEN    bearer token issued by `polaris operators create`",
        "",
        "Profiles: keep multiple environments side-by-side in ~/.polaris/config.toml.",
        "The config file points each profile at the env var holding its token; the",
        "file NEVER stores token plaintext. Pick a profile with --profile <name>",
        "or POLARIS_PROFILE.",
      ].join("\n"),
    )
    .version(meta.version, "-v, --version", "Show CLI version and exit")
    .addOption(new Option("--profile <name>", "Profile defined in ~/.polaris/config.toml"))
    .addOption(
      new Option("--output <format>", "Output format")
        .choices([...OUTPUT_FORMATS])
        .default("human"),
    )
    .addOption(new Option("--debug", "Enable debug-level logging").conflicts("quiet"))
    .addOption(new Option("--quiet", "Suppress non-error output").conflicts("debug"))
    // Documented so `--help` shows the supported env vars without making them
    // commander options. The actual reads happen in `loadCliConfig`.
    .addHelpText(
      "after",
      [
        "",
        "Environment variables:",
        "  POLARIS_API_URL       Base URL of the control-plane API",
        "  POLARIS_TOKEN         Bearer token (used when no profile is selected)",
        "  POLARIS_PROFILE       Default profile name",
        "  POLARIS_LOG_LEVEL     fatal|error|warn|info|debug|trace (default: warn)",
        "  POLARIS_GIT_SHA       Optional build SHA shown by `polaris version`",
        "  POLARIS_BUILD_TIME    Optional build timestamp shown by `polaris version`",
        "",
        "Exit codes:",
        "  0  success",
        "  1  generic failure",
        "  2  usage error",
        "  3  config error",
        "  4  auth error",
        "  5  not implemented (stub command surface)",
      ].join("\n"),
    )
    // Without this, commander calls `process.exit` on `--help`, unknown
    // commands, etc., which makes the CLI uncomposable in tests.
    .exitOverride();

  // Pin help / error output to our streams so unit tests capture them.
  program.configureOutput({
    writeOut: (str) => output.writeOut(str),
    writeErr: (str) => output.writeErr(str),
    getOutHelpWidth: () => 100,
    getErrHelpWidth: () => 100,
  });

  // Helper passed into each command's `register` call.
  const deps: CommandRegistrarDeps = {
    meta,
    runCommand: <Args>(
      definition: { readonly id: string; readonly mutates: boolean },
      handler: CommandHandler<Args>,
    ) => {
      return async (args: Args, _command: Command): Promise<void> => {
        const ctx = await buildContextForCommand({ env, output, meta, program, definition });
        const result = await handler(args, ctx);
        if (result !== undefined && result.exitCode !== ExitCode.Ok) {
          // Wrap a non-OK structured result in CliError so the top-level
          // handler routes it to the right exit code.
          throw new CliError(`command "${definition.id}" returned exit code ${result.exitCode}`, {
            exitCode: result.exitCode,
          });
        }
      };
    },
  };

  for (const command of commands) {
    command.register(program, deps);
  }

  return program;
}

/**
 * Build the per-command context. Reads global flags from the program so each
 * command sees the same resolved values.
 */
async function buildContextForCommand(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly output: OutputStreams;
  readonly meta: PackageMeta;
  readonly program: Command;
  readonly definition: { readonly id: string; readonly mutates: boolean };
}): Promise<CommandContext> {
  const opts = options.program.opts<{
    profile?: string;
    output?: OutputFormat;
    debug?: boolean;
    quiet?: boolean;
  }>();

  const logLevel: CliLogLevel | undefined = opts.debug ? "debug" : opts.quiet ? "error" : undefined;

  const config = loadCliConfig({
    env: options.env,
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(logLevel !== undefined ? { logLevel } : {}),
  });

  const logger = createCliLogger({
    level: config.logLevel,
    meta: options.meta,
    env: deriveLogEnvLabel(config),
  });

  logger.debug(
    {
      command: options.definition.id,
      mutates: options.definition.mutates,
      profile: config.profile,
      api_url: config.apiUrl,
      token_env: config.tokenEnvName,
    },
    "polaris command dispatched",
  );

  return {
    config,
    logger,
    output: options.output,
    meta: options.meta,
  };
}

/**
 * Derive a coarse-grained `env` label for log bindings. The CLI does not know
 * the operational environment of the API it is talking to with certainty, so
 * we fall back to the profile name — `production`, `staging`, etc. The shared
 * logger only uses this as a string label on every line.
 */
function deriveLogEnvLabel(config: { profile: string; apiUrl: string }): string | undefined {
  if (config.profile !== "default") return config.profile;
  // Best-effort guess from the URL: localhost/127.0.0.1 implies local dev.
  try {
    const url = new URL(config.apiUrl);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return "local";
  } catch {
    // Already validated by loadCliConfig; this should not happen.
  }
  return undefined;
}

interface ErrorContext {
  readonly output: OutputStreams;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Translate whatever was thrown during command execution into an exit code
 * and a user-facing message. Handles three categories:
 *
 *   1. commander's own `CommanderError` (parse errors, --help, --version)
 *   2. our `CliError` subclasses (config, auth, usage, not implemented)
 *   3. anything else (treated as `generic_failure`)
 */
function handleTopLevelError(error: unknown, ctx: ErrorContext): ExitCode {
  // commander throws `CommanderError` with `code` and `exitCode` fields after
  // we call `exitOverride()`. We import the type loosely to avoid a runtime
  // import of commander internals.
  if (isCommanderError(error)) {
    // `--help` / `--version` exit with code 0 already.
    if (error.exitCode === 0) return ExitCode.Ok;
    // Treat every other commander code as a usage error.
    if (error.message && error.message.length > 0 && error.code !== "commander.helpDisplayed") {
      ctx.output.writeErr(`polaris: ${error.message}`);
    }
    return ExitCode.UsageError;
  }

  if (isCliError(error)) {
    emitCliError(error, ctx);
    return error.exitCode;
  }

  // Unknown error: surface the message and respect `--debug` for stack output.
  const message = error instanceof Error ? error.message : String(error);
  ctx.output.writeErr(`polaris: ${message}`);
  if (ctx.env["POLARIS_DEBUG"] === "1" && error instanceof Error && error.stack) {
    ctx.output.writeErr(error.stack);
  }
  return ExitCode.GenericFailure;
}

function emitCliError(error: CliError, ctx: ErrorContext): void {
  // For JSON output requested via env (some CI agents prefer it), we honour
  // it best-effort. The flag-based path is set on `config`, but `loadCliConfig`
  // may itself have thrown — so we look at the bare env.
  if (ctx.env["POLARIS_OUTPUT"] === "json") {
    ctx.output.writeErr(
      renderJson({
        error: error.name,
        code: error.exitCode,
        message: error.message,
        details: error.details ?? null,
      }).trimEnd(),
    );
    return;
  }
  ctx.output.writeErr(`polaris: ${error.message}`);
}

interface CommanderLikeError {
  readonly code: string;
  readonly exitCode: number;
  readonly message: string;
}

function isCommanderError(value: unknown): value is CommanderLikeError {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["code"] === "string" &&
    typeof obj["exitCode"] === "number" &&
    typeof obj["message"] === "string" &&
    typeof obj["code"] === "string" &&
    obj["code"].startsWith("commander.")
  );
}

/**
 * Re-export of `UsageError` so command modules can throw without re-importing
 * from the deep error module. Avoids cyclic imports inside `commands/`.
 */
export { UsageError };

/**
 * Validate the requested output value against the supported set. Used by
 * commander option callbacks to fail loudly on typos. `--output` already
 * declares its choices, but the env-var fallback path doesn't go through
 * commander, so the same check lives here.
 */
export function assertSupportedLogLevel(value: string): CliLogLevel {
  if ((CLI_LOG_LEVELS as ReadonlyArray<string>).includes(value)) {
    return value as CliLogLevel;
  }
  throw new UsageError(`unsupported log level "${value}". Allowed: ${CLI_LOG_LEVELS.join(", ")}.`);
}
