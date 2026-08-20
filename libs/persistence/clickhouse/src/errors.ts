/**
 * Typed error classes for @polaris/shared-clickhouse.
 *
 * Errors are intentionally narrow so callers (services, CLI) can branch on
 * them in their RFC 7807 problem-details mappers without doing string
 * matching. The `code` field is the stable contract.
 */

export type ClickHouseErrorCode =
  | "clickhouse_config_invalid"
  | "clickhouse_role_denied"
  | "clickhouse_connection_failed"
  | "clickhouse_query_failed"
  | "clickhouse_escape_hatch_unauthorized"
  | "clickhouse_invariant_violated";

export abstract class ClickHouseError extends Error {
  public abstract readonly code: ClickHouseErrorCode;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = this.constructor.name;
  }
}

/**
 * Thrown when configuration fails Zod validation, or when an invariant on
 * the config object is violated (e.g. role missing).
 */
export class ClickHouseConfigError extends ClickHouseError {
  public override readonly code = "clickhouse_config_invalid" as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Thrown when a method that is reserved for the operator profile is invoked
 * on a service-profile client. This is a defense-in-depth signal: TypeScript
 * already keeps these methods off the service profile, and the database role
 * grants would refuse the query, but a runtime check catches dynamic misuse
 * (e.g. someone calling through `any`).
 */
export class ClickHouseRoleDeniedError extends ClickHouseError {
  public override readonly code = "clickhouse_role_denied" as const;

  public constructor(method: string, requiredRole: "operator") {
    super(
      `Method ${method} requires the '${requiredRole}' profile, but the client was constructed with a different role.`,
    );
  }
}

/**
 * Thrown when the underlying `@clickhouse/client` ping or readiness probe
 * fails. Distinct from query failures because callers typically expose
 * connection failures via `/readyz` and query failures via 5xx responses.
 */
export class ClickHouseConnectionError extends ClickHouseError {
  public override readonly code = "clickhouse_connection_failed" as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Thrown when a query executes but returns an error from ClickHouse. Wraps
 * the underlying client error so call sites do not need to import the
 * `@clickhouse/client` error types.
 */
export class ClickHouseQueryError extends ClickHouseError {
  public override readonly code = "clickhouse_query_failed" as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Thrown when the operator escape hatch is invoked with missing required
 * audit context (`caller`, `reason`). The escape hatch demands those fields
 * so audit logs are meaningful.
 */
export class ClickHouseEscapeHatchUnauthorizedError extends ClickHouseError {
  public override readonly code = "clickhouse_escape_hatch_unauthorized" as const;

  public constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown for internal invariant violations (e.g. a constructor path that
 * should be unreachable was reached). These should never happen at runtime
 * and are a signal of a logic bug, not a configuration or environment issue.
 */
export class ClickHouseInvariantError extends ClickHouseError {
  public override readonly code = "clickhouse_invariant_violated" as const;

  public constructor(message: string) {
    super(`shared-clickhouse invariant violated: ${message}`);
  }
}
