/**
 * Operator-profile ClickHouse client construction for the CLI.
 *
 * Mirrors `apps/polaris-cli/src/db/connect.ts` (the Postgres bridge):
 * one small env-driven factory, returns a `{ client, close }` handle,
 * fails with `ConfigError` (exit code 3) when env is incomplete. Both
 * `defaultDriver()` (executor side, BL565N7Y) and
 * `defaultReadPartitions()` (planner side, U342CPX9) call this — the
 * connection wiring lives in one place so a future
 * `requestTimeoutMs` / TLS tweak only changes here.
 *
 * The function takes `env` (not `process.env`) per the
 * `CommandContext.env` convention introduced in `daf8fb9` /
 * `5282a0f` — production passes `ctx.env`, tests pass a synthetic
 * env object, no module-level `process.env` lookup at any call site.
 */
import { type ClickHouseOperatorClient, createClickHouseClient } from "@polaris/shared-clickhouse";
import { clickhouseEnvSchema } from "@polaris/shared-config";

import { ConfigError } from "../errors.js";

export interface OperatorClickHouseHandle {
  readonly client: ClickHouseOperatorClient;
  readonly database: string;
  readonly close: () => Promise<void>;
}

/**
 * Construct an operator-profile ClickHouse client from the supplied
 * env. Refuses with `ConfigError` if any of
 * `POLARIS_CLICKHOUSE_URL`, `POLARIS_CLICKHOUSE_DATABASE`,
 * `POLARIS_CLICKHOUSE_OPERATOR_USER`, or
 * `POLARIS_CLICKHOUSE_OPERATOR_PASSWORD` are missing — the operator
 * profile is required because every rebuild-side SQL call leaves an
 * audit trail through the `raw.query` escape hatch.
 *
 * Callers MUST `close()` the handle.
 */
export function connectOperatorClickHouse(env: NodeJS.ProcessEnv): OperatorClickHouseHandle {
  let parsed: ReturnType<typeof clickhouseEnvSchema.parse>;
  try {
    parsed = clickhouseEnvSchema.parse(env);
  } catch (cause) {
    throw new ConfigError(
      `POLARIS_CLICKHOUSE_* env is required: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed.operator === undefined) {
    throw new ConfigError(
      "POLARIS_CLICKHOUSE_OPERATOR_USER and POLARIS_CLICKHOUSE_OPERATOR_PASSWORD are required to read system.parts / run rebuilds. The operator profile leaves audit-log entries on every SQL call.",
    );
  }
  const client = createClickHouseClient({
    role: "operator",
    url: parsed.url,
    database: parsed.database,
    credential: {
      username: parsed.operator.user,
      password: parsed.operator.password,
    },
    requestTimeoutMs: parsed.requestTimeoutMs,
    maxOpenConnections: parsed.maxOpenConnections,
    application: "polaris-cli",
  });
  return {
    client,
    database: parsed.database,
    close: () => client.close(),
  };
}
