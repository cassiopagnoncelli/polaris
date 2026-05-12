import type { ZodError } from "zod";

/**
 * Thrown when runtime configuration fails validation.
 *
 * Services should let this propagate at startup so the process exits with a
 * non-zero status and an obviously-failed-config signal in the logs. The
 * error message is a human-readable, multi-line summary of every invalid
 * field. The `issues` property exposes the raw Zod issues for callers that
 * want to render them differently (e.g. CLI tooling).
 */
export class ConfigValidationError extends Error {
  public override readonly name = "ConfigValidationError";

  public readonly issues: ReadonlyArray<ConfigValidationIssue>;

  public readonly serviceName: string;

  constructor(serviceName: string, zodError: ZodError) {
    const issues = zodError.issues.map(
      (issue): ConfigValidationIssue => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        message: issue.message,
        code: issue.code,
      }),
    );
    const summary = issues
      .map((issue) => `  - ${issue.path || "(root)"}: ${issue.message}`)
      .join("\n");
    super(
      `Invalid runtime configuration for service "${serviceName}":\n${summary}\n` +
        "Fix the offending environment variables and restart.",
    );
    this.issues = issues;
    this.serviceName = serviceName;
  }
}

export interface ConfigValidationIssue {
  /** Dot-joined path to the invalid field (e.g. "postgres.port"). */
  readonly path: string;
  /** Human-readable message from Zod. */
  readonly message: string;
  /** Zod issue code (e.g. "invalid_type", "too_small"). */
  readonly code: string;
}
