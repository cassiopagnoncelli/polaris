import {
  enforceProductionMutationGate,
  type GateEnvironment,
  isGateEnvironment,
  OPERATOR_TOKEN_ENV_VAR,
  type OperatorTokenRepository,
  ProductionMutationRefusedError,
  type ResolvedActor,
  resolveActor,
} from "@polaris/tenancy-control-plane";
import { Command, Option } from "commander";
import type {
  CommandContext,
  CommandDefinition,
  CommandHandler,
  CommandRegistrarDeps,
} from "./command.js";
import { BUILTIN_COMMANDS } from "./commands/index.js";
import {
  CLI_LOG_LEVELS,
  type CliLogLevel,
  loadCliConfig,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "./config.js";
import { connectDb } from "./db/connect.js";
import { CliError, ExitCode, isCliError, UsageError } from "./errors.js";
import { createCliLogger } from "./logger.js";
import { createKyselyOperatorTokenRepository } from "./operators/repository.js";
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
  /**
   * Test override: a pre-resolved actor. Production passes nothing and the
   * dispatcher resolves the actor itself by consulting `POLARIS_OPERATOR_TOKEN`
   * + the operator-tokens repository.
   */
  readonly actor?: ResolvedActor;
  /**
   * Test override: a synthetic operator-token repository. Production
   * constructs a Kysely-backed one only when `POLARIS_OPERATOR_TOKEN` is
   * set, so a typical CLI invocation pays no DB cost.
   */
  readonly operatorTokenRepository?: OperatorTokenRepository;
  /**
   * Test override: a deterministic secret-tail verifier. Production uses
   * the platform's argon2id verifier from `@polaris/runtime-secrets`; tests
   * substitute a fast stub so the suite does not pay the ~30ms argon2
   * cost per case. NEVER set this in production — every production CLI
   * invocation uses argon2id.
   */
  readonly operatorTokenVerify?: (
    plaintext: string,
    hash: string,
    algorithm: string,
  ) => Promise<boolean>;
}

/**
 * Execute the CLI and resolve to the exit code the process should use.
 *
 * Never calls `process.exit` itself — the binary entry point in
 * `bin/polaris.ts` handles that. Returning a code keeps unit tests free of
 * `process.exit` mocking.
 *
 * Lifecycle:
 *
 *   1. Resolve the actor ONCE for this invocation. The result becomes
 *      `ctx.actor` for every handler the dispatcher calls.
 *   2. Build the commander program with the right hooks. Every mutating
 *      command call goes through the production-mutation gate before the
 *      handler runs.
 *   3. Parse argv. Any refusal from the gate, or any other handler error,
 *      lands in `handleTopLevelError` and is mapped to an exit code.
 *
 * The actor resolution opens a DB connection ONLY when
 * `POLARIS_OPERATOR_TOKEN` is set and no repository was injected; the
 * default CLI invocation (no env var) skips PostgreSQL entirely.
 */
export async function run(options: RunOptions): Promise<ExitCode> {
  const env = options.env ?? process.env;
  const output = options.output ?? createOutputStreams();
  const meta = options.meta ?? resolvePackageMeta(env);
  const commands = options.commands ?? BUILTIN_COMMANDS;

  let actor: ResolvedActor;
  let closeRepository: (() => Promise<void>) | undefined;
  try {
    if (options.actor !== undefined) {
      actor = options.actor;
    } else if (options.operatorTokenRepository !== undefined) {
      actor = await resolveActor({
        env,
        repository: options.operatorTokenRepository,
        ...(options.operatorTokenVerify !== undefined
          ? { verify: options.operatorTokenVerify }
          : {}),
      });
    } else if (hasOperatorTokenEnvVar(env)) {
      // Open a DB connection only when there's actually a token to verify.
      const handle = connectDb({ env });
      closeRepository = handle.close;
      actor = await resolveActor({
        env,
        repository: createKyselyOperatorTokenRepository(handle.db),
      });
    } else {
      actor = { source: "cli", label: "cli" };
    }
  } catch (error: unknown) {
    if (closeRepository !== undefined) await closeRepository();
    return handleTopLevelError(error, { output, env });
  }

  try {
    const program = buildProgram({ env, output, meta, commands, actor });
    // commander reads `program.exitOverride()` to throw instead of `process.exit`
    // on parse failures; we already do that in `buildProgram`. Wrap the parse
    // call to map commander's exit-override errors to our `ExitCode` values.
    try {
      await program.parseAsync(options.argv as string[], { from: "user" });
      return ExitCode.Ok;
    } catch (error: unknown) {
      return handleTopLevelError(error, { output, env });
    }
  } finally {
    if (closeRepository !== undefined) await closeRepository();
  }
}

function hasOperatorTokenEnvVar(env: NodeJS.ProcessEnv): boolean {
  const raw = env[OPERATOR_TOKEN_ENV_VAR];
  return typeof raw === "string" && raw.trim().length > 0;
}

interface BuildOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly output: OutputStreams;
  readonly meta: PackageMeta;
  readonly commands: readonly CommandDefinition[];
  /**
   * Resolved actor for this invocation. Pinned by `run(...)` so every
   * handler sees the same identity and the gate consults the same source.
   */
  readonly actor: ResolvedActor;
}

/**
 * Construct the commander program with all global flags and commands wired in.
 *
 * Exported for tests that want to inspect the help text or simulate parse
 * errors without going through `run`.
 */
export function buildProgram(options: BuildOptions): Command {
  const { env, output, meta, commands, actor } = options;
  const program = new Command();

  program
    .name("polaris")
    .description(
      [
        "Polaris control-plane CLI — thin client for the control-plane API.",
        "",
        "Authentication: bash-invocable, no interactive login. The CLI reads:",
        "  POLARIS_API_URL  base URL of the control-plane API (required only for HTTP commands)",
        "  POLARIS_TOKEN    bearer token issued by `polaris operators create` (same)",
        "",
        "v1 commands are DATABASE_URL-direct and do not require either var.",
        "",
        "Production mutations require an authenticated operator token. Set",
        "POLARIS_OPERATOR_TOKEN to a value issued via `polaris operators create`",
        "before running any mutating command against a production environment.",
        "",
        "Profiles: keep multiple environments side-by-side in ~/.polaris/config.toml.",
        "The config file points each profile at the env var holding its token; the",
        "file NEVER stores token plaintext. Pick a profile with --profile <name>",
        "or POLARIS_PROFILE.",
      ].join("\n"),
    )
    .version(meta.version, "-v, --version", "Show CLI version and exit")
    // Documented so `--help` shows the supported env vars without making them
    // commander options. The actual reads happen in `loadCliConfig`.
    .addHelpText(
      "after",
      [
        "",
        "Environment variables:",
        "  POLARIS_API_URL          Base URL of the control-plane API (required for HTTP commands only)",
        "  POLARIS_TOKEN            Bearer token, used when no profile is selected (HTTP commands only)",
        "  POLARIS_PROFILE          Default profile name",
        "  POLARIS_OPERATOR_TOKEN   Operator credential for production mutations",
        "  POLARIS_ENV              Effective environment for the gate (development|staging|production)",
        "  POLARIS_LOG_LEVEL        fatal|error|warn|info|debug|trace (default: warn)",
        "  POLARIS_GIT_SHA          Optional build SHA shown by `polaris version`",
        "  POLARIS_BUILD_TIME       Optional build timestamp shown by `polaris version`",
        "  POLARIS_RELEASE_LABEL    Optional pipeline release label shown by `polaris version`",
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
    .exitOverride()
    // Options declared here are matched ANYWHERE in argv unless positional
    // options are on — which meant the root's `--version` swallowed
    // `processors enable <name> --version v1`, printing the CLI version and
    // exiting 0. See `attachGlobalOptions` for why every command re-declares
    // the global flags instead of inheriting them.
    .enablePositionalOptions();

  for (const option of globalOptions()) {
    program.addOption(option);
  }

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
      return async (args: Args, command: Command): Promise<void> => {
        // Production-mutation gate. Applied for every command, ONCE,
        // after argv has parsed (so `--env` is visible on `args`) and
        // BEFORE the handler runs. Refusals throw
        // `ProductionMutationRefusedError`, which `handleTopLevelError`
        // maps to exit code 2 (usage error class — operator can fix it
        // by setting POLARIS_OPERATOR_TOKEN).
        const gateEnvironment = resolveGateEnvironment(args, env);
        enforceProductionMutationGate({
          command: { id: definition.id, mutates: definition.mutates },
          environment: gateEnvironment,
          actor,
        });

        const ctx = await buildContextForCommand({
          env,
          output,
          meta,
          program,
          invoked: command,
          definition,
          actor,
        });
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

  attachGlobalOptions(program);

  return program;
}

/**
 * The flags every command accepts, rebuilt fresh per command.
 *
 * Fresh instances matter: commander stores parse state on the `Option`, so
 * one shared instance across 40+ commands would leak values between them.
 *
 * `--output` carries no commander-level default on purpose — `loadCliConfig`
 * owns the fallback, and a default here would report a source of `"default"`
 * at every level of the command chain, which is exactly the signal
 * {@link resolveGlobalOption} uses to find the level the operator typed at.
 */
function globalOptions(): readonly Option[] {
  return [
    new Option("--profile <name>", "Profile defined in ~/.polaris/config.toml"),
    new Option("--output <format>", "Output format (default: human)").choices([...OUTPUT_FORMATS]),
    new Option("--debug", "Enable debug-level logging").conflicts("quiet"),
    new Option("--quiet", "Suppress non-error output").conflicts("debug"),
  ];
}

/**
 * Re-declare the global flags on every subcommand, and turn on positional
 * options all the way down.
 *
 * Commander does not scope options to the command they were declared on: with
 * positional options off, the root matches a known flag anywhere in argv, so
 * `polaris processors enable x --version v1` hit the root's `--version` and
 * printed `0.0.0`. `enablePositionalOptions()` fixes that by making each
 * level parse only the options it owns.
 *
 * The cost is that a global flag would then only be accepted before the
 * subcommand — breaking `polaris destinations list --output json`, the form
 * the ops runbooks use. Re-declaring the globals on each command buys back
 * both positions. Copies are hidden from per-command help; the root's
 * `--help` is where they are documented.
 *
 * A command that declares its own flag of the same name keeps it — the
 * `_findOption` check below never overwrites a real command option.
 */
function attachGlobalOptions(parent: Command): void {
  for (const command of parent.commands) {
    command.enablePositionalOptions();
    for (const option of globalOptions()) {
      if (command.options.some((existing) => existing.long === option.long)) continue;
      command.addOption(option.hideHelp());
    }
    attachGlobalOptions(command);
  }
}

/**
 * Read a global flag from the level of the command chain the operator
 * actually typed it at.
 *
 * With the globals re-declared per command, `--output json` may land on the
 * leaf (`processors list --output json`), on a group, or on the root
 * (`polaris --output json processors list`). Walk leaf-to-root and take the
 * first level whose value came from argv; fall back to the root otherwise.
 *
 * Deliberately not `optsWithGlobals()` — that merges root LAST, so the root
 * would win over the leaf, which is backwards.
 */
function resolveGlobalOption<T>(invoked: Command | undefined, program: Command, key: string): T {
  for (let command = invoked; command !== undefined; command = command.parent ?? undefined) {
    // Defensive: an action handler registered without commander's trailing
    // `Command` argument passes something else here.
    if (typeof command.getOptionValueSource !== "function") break;
    if (command.getOptionValueSource(key) === "cli") {
      return command.getOptionValue(key) as T;
    }
  }
  return program.getOptionValue(key) as T;
}

/**
 * Determine the effective environment for the gate.
 *
 * Resolution order:
 *
 *   1. The command's parsed `--env` flag, if present and a recognised
 *      value. Commands with their own `--env` carry the operator's
 *      explicit intent (`polaris keys create --env production ...`).
 *   2. `POLARIS_ENV` env var. Lets operators pin "this shell talks to
 *      production" once, instead of repeating `--env` on each call.
 *   3. `undefined` — the gate is a no-op when neither is set. For
 *      commands where the operative environment lives in a DB row
 *      (`destinations.disable <id>`), operators MUST set
 *      `POLARIS_ENV=production` to opt the run into the gate; this
 *      matches the architecture-doc contract that the gate is the
 *      ONE rule and does not pre-fetch operative rows.
 */
function resolveGateEnvironment<Args>(
  args: Args,
  env: NodeJS.ProcessEnv,
): GateEnvironment | undefined {
  if (typeof args === "object" && args !== null) {
    // commander parses `--env <value>` into `args.env` for option-based
    // commands, but the same shape is used for any object with an `env`
    // property; defensive index-access keeps the closure-property strict
    // mode happy.
    const candidate = (args as Record<string, unknown>)["env"];
    if (typeof candidate === "string" && isGateEnvironment(candidate)) {
      return candidate;
    }
  }
  const fromEnv = env["POLARIS_ENV"];
  if (typeof fromEnv === "string" && isGateEnvironment(fromEnv)) {
    return fromEnv;
  }
  return undefined;
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
  /** The command commander dispatched to. Globals may be set at any level above it. */
  readonly invoked: Command | undefined;
  readonly definition: { readonly id: string; readonly mutates: boolean };
  readonly actor: ResolvedActor;
}): Promise<CommandContext> {
  const opts = {
    profile: resolveGlobalOption<string | undefined>(options.invoked, options.program, "profile"),
    output: resolveGlobalOption<OutputFormat | undefined>(
      options.invoked,
      options.program,
      "output",
    ),
    debug: resolveGlobalOption<boolean | undefined>(options.invoked, options.program, "debug"),
    quiet: resolveGlobalOption<boolean | undefined>(options.invoked, options.program, "quiet"),
  };

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
      actor_source: options.actor.source,
      actor_label: options.actor.label,
    },
    "polaris command dispatched",
  );

  return {
    config,
    logger,
    output: options.output,
    meta: options.meta,
    actor: options.actor,
    env: options.env,
  };
}

/**
 * Derive a coarse-grained `env` label for log bindings. The CLI does not know
 * the operational environment of the API it is talking to with certainty, so
 * we fall back to the profile name — `production`, `staging`, etc. The shared
 * logger only uses this as a string label on every line.
 */
function deriveLogEnvLabel(config: { profile: string; apiUrl: string | null }): string | undefined {
  if (config.profile !== "default") return config.profile;
  if (config.apiUrl === null) return undefined;
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
 * and a user-facing message. Handles four categories:
 *
 *   1. commander's own `CommanderError` (parse errors, --help, --version)
 *   2. our `CliError` subclasses (config, auth, usage, not implemented)
 *   3. `ProductionMutationRefusedError` from the dispatcher gate
 *   4. anything else (treated as `generic_failure`)
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

  if (error instanceof ProductionMutationRefusedError) {
    // Refusal surface: clean stderr message + exit code 2 (usage-error
    // class). The operator's fix is to set POLARIS_OPERATOR_TOKEN or run
    // against a non-production environment; both are operator-correctable.
    ctx.output.writeErr(`polaris: ${error.message}`);
    return ExitCode.UsageError;
  }

  if (isCliError(error)) {
    emitCliError(error, ctx);
    return error.exitCode;
  }

  // Unknown error: surface the message and respect `--debug` for stack output.
  ctx.output.writeErr(`polaris: ${describeUnknownError(error)}`);
  if (ctx.env["POLARIS_DEBUG"] === "1" && error instanceof Error && error.stack) {
    ctx.output.writeErr(error.stack);
  }
  return ExitCode.GenericFailure;
}

/**
 * Best-effort one-line description of an error the CLI does not model.
 *
 * `error.message` alone is not enough. A refused PostgreSQL connection
 * arrives as an `AggregateError` — Node's happy-eyeballs path wraps one error
 * per resolved address — and its own `message` is the empty string, so the
 * CLI printed a bare `polaris: ` and exited 1. Fall back to the error `code`,
 * then to the wrapped errors, then to the constructor name, so there is
 * always something actionable on stderr.
 */
function describeUnknownError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  // `AggregateError.errors` — one entry per address attempted. Duplicates are
  // common (same failure on ::1 and 127.0.0.1) and add nothing.
  const nested = (error as { errors?: unknown }).errors;
  const inner = Array.isArray(nested)
    ? [
        ...new Set(
          nested
            .map((item) => (item instanceof Error ? describeUnknownError(item) : String(item)))
            .filter((text) => text.length > 0),
        ),
      ].join("; ")
    : "";

  const text = [error.message, inner].filter((part) => part.length > 0).join(" ");
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && code.length > 0 && !text.includes(code)) {
    return text.length > 0 ? `${text} (${code})` : code;
  }
  return text.length > 0 ? text : error.constructor.name;
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
