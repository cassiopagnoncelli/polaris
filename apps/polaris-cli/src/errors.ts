/**
 * Stable exit codes used by the `polaris` CLI.
 *
 * Scripts piping `polaris` into other tooling rely on these codes being
 * stable, so new codes only get added — existing values must not be reused.
 *
 *   0   ok                  command succeeded
 *   1   generic_failure     unexpected runtime error
 *   2   usage_error         invalid args, unknown flag, conflicting options
 *   3   config_error        missing or invalid env vars / profile / config file
 *   4   auth_error          POLARIS_TOKEN missing or rejected (P6-000+)
 *   5   not_implemented     command surface exists but the body is a stub
 */
export const ExitCode = {
  Ok: 0,
  GenericFailure: 1,
  UsageError: 2,
  ConfigError: 3,
  AuthError: 4,
  NotImplemented: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Base class for CLI-aware errors. Differs from a plain `Error` in two ways:
 *
 *   1. It carries an explicit exit code so the top-level error handler does
 *      not need to introspect message strings to pick one.
 *   2. It is recognisable via `isCliError` (and a stable `name`) so the
 *      `--debug` flag can decide whether to dump a stack trace.
 */
export class CliError extends Error {
  public override readonly name: string = "CliError";

  public readonly exitCode: ExitCode;

  /**
   * Optional structured fields shown when `--output json` is set. Plain
   * messages stay in the `message` slot to keep the human and JSON paths
   * aligned.
   */
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    message: string,
    options: { readonly exitCode?: ExitCode; readonly details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.exitCode = options.exitCode ?? ExitCode.GenericFailure;
    this.details = options.details;
  }
}

export class ConfigError extends CliError {
  public override readonly name = "ConfigError";
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      exitCode: ExitCode.ConfigError,
      ...(details ? { details } : {}),
    });
  }
}

export class UsageError extends CliError {
  public override readonly name = "UsageError";
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      exitCode: ExitCode.UsageError,
      ...(details ? { details } : {}),
    });
  }
}

export class AuthError extends CliError {
  public override readonly name = "AuthError";
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      exitCode: ExitCode.AuthError,
      ...(details ? { details } : {}),
    });
  }
}

export class NotImplementedError extends CliError {
  public override readonly name = "NotImplementedError";
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      exitCode: ExitCode.NotImplemented,
      ...(details ? { details } : {}),
    });
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}
