/**
 * Tests for the operator-profile ClickHouse env-validation chokepoint
 * (U342CPX9).
 *
 * `connectOperatorClickHouse` is the single env-failure path for both
 * `defaultDriver` (executor side, BL565N7Y) and `defaultReadPartitions`
 * (planner side, U342CPX9). Its contract:
 *
 *   - missing `POLARIS_CLICKHOUSE_*` core vars → ConfigError
 *   - missing `POLARIS_CLICKHOUSE_OPERATOR_*` → ConfigError
 *   - both present → returns a handle (we don't open a real connection
 *     here; the underlying `@clickhouse/client` opens lazily on first
 *     query, so construction is safe).
 */

import { describe, expect, it } from "vitest";

import { connectOperatorClickHouse } from "../src/clickhouse/connect.js";
import { ConfigError } from "../src/index.js";

const FULL_ENV: NodeJS.ProcessEnv = {
  POLARIS_CLICKHOUSE_URL: "http://clickhouse.example.internal:8123",
  POLARIS_CLICKHOUSE_DATABASE: "polaris",
  POLARIS_CLICKHOUSE_SERVICE_USER: "polaris_service",
  POLARIS_CLICKHOUSE_SERVICE_PASSWORD: "service-secret",
  POLARIS_CLICKHOUSE_OPERATOR_USER: "polaris_operator",
  POLARIS_CLICKHOUSE_OPERATOR_PASSWORD: "operator-secret",
};

describe("connectOperatorClickHouse", () => {
  it("happy path: constructs a handle with the parsed database carried through", () => {
    const handle = connectOperatorClickHouse(FULL_ENV);
    expect(handle.client.role).toBe("operator");
    expect(handle.database).toBe("polaris");
    // close() is idempotent against an unused client.
    return handle.close();
  });

  it("missing URL: throws ConfigError before constructing a client", () => {
    const env = { ...FULL_ENV };
    delete env.POLARIS_CLICKHOUSE_URL;
    expect(() => connectOperatorClickHouse(env)).toThrow(ConfigError);
  });

  it("missing operator user: ConfigError calls out the operator profile requirement", () => {
    const env = { ...FULL_ENV };
    delete env.POLARIS_CLICKHOUSE_OPERATOR_USER;
    delete env.POLARIS_CLICKHOUSE_OPERATOR_PASSWORD;
    let thrown: unknown = null;
    try {
      connectOperatorClickHouse(env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    if (thrown instanceof Error) {
      expect(thrown.message).toMatch(/OPERATOR_USER/);
    }
  });

  it("operator user without password: rejected by the env-pair invariant", () => {
    // clickhouseEnvSchema's superRefine enforces both-or-neither.
    const env = { ...FULL_ENV };
    delete env.POLARIS_CLICKHOUSE_OPERATOR_PASSWORD;
    expect(() => connectOperatorClickHouse(env)).toThrow(ConfigError);
  });

  it("operator password without user: rejected by the env-pair invariant", () => {
    const env = { ...FULL_ENV };
    delete env.POLARIS_CLICKHOUSE_OPERATOR_USER;
    expect(() => connectOperatorClickHouse(env)).toThrow(ConfigError);
  });
});
