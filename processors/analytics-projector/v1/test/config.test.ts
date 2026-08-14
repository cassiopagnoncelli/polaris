/**
 * Config-schema tests for the projector's OPTIONAL ClickHouse section.
 *
 * The projector does not write to ClickHouse — it polls `system.*` for the
 * health gauges behind the three v1 ClickHouse alerts — so a deployment
 * without ClickHouse is a complete deployment. That makes `clickhouse` the one
 * section here that has to parse to `undefined` rather than fail, and gets it
 * its own tests: the shared `clickhouseEnvSchema` requires
 * `POLARIS_CLICKHOUSE_URL`, so composing it directly would have made every
 * ClickHouse-less deployment fail to boot.
 *
 * These replace a gate that lived in `buildApp` and read `process.env`
 * directly. That version had no test at all — and could not easily have one,
 * since it depended on ambient process state — while also bypassing the `.env`
 * cascade `loadConfigWithDefaults` applies.
 */

import { describe, expect, it } from "vitest";

import { analyticsProjectorConfigSchema } from "../src/config.js";

/** The minimum every other section needs, so the tests below vary one thing. */
const BASE_ENV = {
  POLARIS_SERVICE_NAME: "analytics-projector",
  POLARIS_SERVICE_VERSION: "0.0.0-test",
  POLARIS_ENV: "development",
  POLARIS_POSTGRES_HOST: "localhost",
  POLARIS_POSTGRES_DATABASE: "polaris",
  POLARIS_POSTGRES_USER: "polaris",
  POLARIS_POSTGRES_PASSWORD: "polaris",
  POLARIS_RABBITMQ_URL: "amqp://guest:guest@localhost:5672",
  POLARIS_RABBITMQ_CLIENT_ID: "analytics-projector-test",
} as const;

/**
 * A COMPLETE ClickHouse block. The shared schema wants more than a URL —
 * database and service credentials too — so a test that set only the URL
 * would fail for the wrong reason and prove nothing about the optional
 * wrapper.
 */
const CLICKHOUSE_ENV = {
  POLARIS_CLICKHOUSE_URL: "http://localhost:8123",
  POLARIS_CLICKHOUSE_DATABASE: "polaris",
  POLARIS_CLICKHOUSE_SERVICE_USER: "polaris_service",
  POLARIS_CLICKHOUSE_SERVICE_PASSWORD: "service-secret",
} as const;

function parse(extra: Record<string, string> = {}) {
  return analyticsProjectorConfigSchema().safeParse({ ...BASE_ENV, ...extra });
}

describe("analyticsProjectorConfigSchema — optional clickhouse section", () => {
  it("parses to undefined when no ClickHouse URL is set", () => {
    const result = parse();
    expect(result.success).toBe(true);
    expect(result.success ? result.data.clickhouse : "unparsed").toBeUndefined();
  });

  it("parses the section when ClickHouse is configured", () => {
    const result = parse(CLICKHOUSE_ENV);
    expect(result.success).toBe(true);
    expect(result.success ? result.data.clickhouse?.url : undefined).toBe("http://localhost:8123");
    expect(result.success ? result.data.clickhouse?.database : undefined).toBe("polaris");
  });

  it("treats an empty URL as absent, not as a malformed one", () => {
    // A deployment template that renders `POLARIS_CLICKHOUSE_URL=` for an
    // environment without ClickHouse must boot, not crash. The env is strings
    // all the way down, so "unset" and "set to empty" reach us identically
    // enough that they have to mean the same thing.
    const result = parse({ ...CLICKHOUSE_ENV, POLARIS_CLICKHOUSE_URL: "" });
    expect(result.success).toBe(true);
    expect(result.success ? result.data.clickhouse : "unparsed").toBeUndefined();
  });

  it("FAILS when ClickHouse is configured but incomplete", () => {
    // The opt-out is "no ClickHouse", not "some ClickHouse". Half a block is a
    // deployment error and must fail at boot; silently disabling the probes
    // would take the three ClickHouse alerts down with it, and an alert that
    // cannot fire looks exactly like a healthy system.
    const { POLARIS_CLICKHOUSE_SERVICE_PASSWORD: _omitted, ...incomplete } = CLICKHOUSE_ENV;
    expect(parse(incomplete).success).toBe(false);
  });

  it("still FAILS on a URL that is set but malformed", () => {
    // The opt-out is "no URL", not "any URL". A typo'd host is a deployment
    // error and must fail loudly at boot rather than silently disabling the
    // probes — which would take the three ClickHouse alerts down with it, and
    // an alert that cannot fire looks exactly like a healthy system.
    const result = parse({ ...CLICKHOUSE_ENV, POLARIS_CLICKHOUSE_URL: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("leaves the required sections required", () => {
    // The optional wrapper is scoped to clickhouse; a missing broker URL is
    // still a boot failure.
    const { POLARIS_RABBITMQ_URL: _omitted, ...withoutBroker } = BASE_ENV;
    expect(analyticsProjectorConfigSchema().safeParse(withoutBroker).success).toBe(false);
  });
});
