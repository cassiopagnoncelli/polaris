import type { ResolvedActor } from "@polaris/shared-control-plane";
import type { Logger } from "@polaris/shared-logger";
import type { Command } from "commander";
import type { CliConfig } from "./config.js";
import type { ExitCode } from "./errors.js";
import type { OutputStreams } from "./output.js";
import type { PackageMeta } from "./package-meta.js";

/**
 * Runtime context handed to every command handler.
 *
 * The shell builds one context per CLI invocation and threads it through the
 * dispatcher. Handlers receive everything they need (config, logger, output
 * sinks, package meta, resolved actor) and never reach into `process.env` or
 * `process.stdout` directly, so tests can drive them deterministically.
 *
 * `actor` is resolved once by the dispatcher (`resolveActor()` from
 * `@polaris/shared-control-plane`) before any handler runs. Commands stamp
 * `actor.source` and `actor.label` onto audit rows so the persisted row
 * reflects the authenticated operator (when `POLARIS_OPERATOR_TOKEN` was
 * set) or the `cli` fallback (when it was not). The same `actor` is what
 * the dispatcher gate consulted to allow or refuse the run.
 */
export interface CommandContext {
  readonly config: CliConfig;
  readonly logger: Logger;
  readonly output: OutputStreams;
  readonly meta: PackageMeta;
  readonly actor: ResolvedActor;
  /**
   * The process environment as seen by this CLI invocation. Threaded
   * from `run({ env })` so handlers can construct DB connections and
   * read config-relevant vars without reaching into `process.env`. In
   * production this is `process.env`; in tests it's the synthetic env
   * the test passed to `run()`.
   *
   * Handlers that open a DB connection MUST use `ctx.env` (passing it
   * to `connectDb({ env: ctx.env })`); reading `process.env` directly
   * leaks the developer's real environment into tests that mean to
   * exercise the "no var set" path.
   */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Structured return value of a command handler.
 *
 * Handlers that don't override the exit code can simply return nothing — the
 * dispatcher treats an implicit `undefined` as "exit 0 with whatever was
 * already written to the streams". Returning a `CommandResult` lets the
 * handler choose an explicit exit code (e.g. `not_implemented` for stubs).
 */
export interface CommandResult {
  readonly exitCode: ExitCode;
}

/**
 * Signature every command handler implements.
 *
 * The dispatcher invokes handlers with the parsed command-specific args and
 * the shared context. Handlers that don't need to override the exit code can
 * simply return nothing (the implicit `void`) — the dispatcher treats that
 * the same as `undefined` and exits 0.
 *
 * Errors should be thrown as `CliError` subclasses so the top-level handler
 * can pick the right exit code; non-CliError throws are treated as
 * `generic_failure` and printed with a stack trace under `--debug`.
 */
export type CommandHandler<Args = unknown> = (
  args: Args,
  ctx: CommandContext,
) => Promise<CommandResult | undefined> | CommandResult | undefined;

/**
 * Declarative command registration.
 *
 * `register(program)` is invoked with the root commander program (or a
 * subcommand group). The registrar should attach exactly one command, its
 * flags, and an `.action()` that calls `runCommand(...)` with the context.
 *
 * `mutates` is part of the public registration surface even though P6-001
 * does not yet enforce the production-mutation gate (that lands in P6-007).
 * Commands MUST declare it now so adding the gate later is a one-line
 * dispatcher change rather than a sweep across every command package.
 */
export interface CommandDefinition {
  /**
   * Stable dotted command path used for audit/log identifiers, e.g.
   * `"version"`, `"keys.create"`, `"replays.approve"`.
   */
  readonly id: string;
  /**
   * Whether the command performs a state-changing API call.
   *
   * `false` for read-only commands. `true` for any command that issues
   * `POST`/`PUT`/`PATCH`/`DELETE` to the control-plane API or otherwise
   * mutates platform state. P6-007 will gate `mutates: true` commands in
   * production against authenticated operator sources.
   */
  readonly mutates: boolean;
  /**
   * Attach this command to the given commander parent. Implementations
   * typically call `parent.command("foo").description("...")...action(...)`.
   */
  readonly register: (parent: Command, deps: CommandRegistrarDeps) => void;
}

/**
 * Shared dependencies that the dispatcher hands to every `register` call.
 *
 * Registrars don't have access to the context yet — that is built once the
 * commander program has parsed argv. They DO have access to the meta object
 * (used by `polaris version` to wire its body), and the dispatcher's
 * `runCommand` helper which centralises context construction and error
 * formatting.
 */
export interface CommandRegistrarDeps {
  readonly meta: PackageMeta;
  /**
   * Wrap a handler so the commander `.action(...)` callback gets:
   *
   *   1. A pre-built `CommandContext` (config loaded, logger ready, streams
   *      wired up).
   *   2. Uniform error handling that maps `CliError` subclasses to exit codes
   *      and unknown errors to `generic_failure`.
   */
  readonly runCommand: <Args>(
    definition: Pick<CommandDefinition, "id" | "mutates">,
    handler: CommandHandler<Args>,
  ) => (args: Args, command: Command) => Promise<void>;
}
