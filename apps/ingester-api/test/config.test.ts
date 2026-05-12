import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadConfig } from "@polaris/shared-config";

import {
  INGESTER_SERVICE_NAME,
  ingesterConfigSchema,
  loadIngesterConfig,
  type IngesterConfig,
} from "../src/config.js";

const basePostgresEnv: Record<string, string> = {
  POLARIS_POSTGRES_HOST: "localhost",
  POLARIS_POSTGRES_DATABASE: "polaris",
  POLARIS_POSTGRES_USER: "polaris",
  POLARIS_POSTGRES_PASSWORD: "polaris",
};

const baseEnv: Record<string, string> = {
  POLARIS_SERVICE_NAME: INGESTER_SERVICE_NAME,
  POLARIS_SERVICE_VERSION: "1.2.3",
  POLARIS_ENV: "local",
  ...basePostgresEnv,
};

function parseEnv(env: Record<string, string>): IngesterConfig {
  return loadConfig({
    serviceName: INGESTER_SERVICE_NAME,
    schema: ingesterConfigSchema(),
    env,
  }) as IngesterConfig;
}

describe("ingesterConfigSchema", () => {
  it("parses a minimal env source with shared defaults", () => {
    const config = parseEnv({ ...baseEnv });
    expect(config.service.serviceName).toBe(INGESTER_SERVICE_NAME);
    expect(config.service.serviceVersion).toBe("1.2.3");
    expect(config.service.environment).toBe("local");
    expect(config.http.host).toBe("0.0.0.0");
    expect(config.http.port).toBe(3000);
    expect(config.http.bodyLimitBytes).toBe(1_048_576);
    expect(config.postgres.host).toBe("localhost");
    expect(config.postgres.database).toBe("polaris");
    expect(config.postgres.poolMax).toBe(10);
    expect(config.authCache.maxEntries).toBe(1024);
    expect(config.authCache.ttlMs).toBe(60_000);
    expect(config.authCache.negativeTtlMs).toBe(5_000);
  });

  it("respects HTTP overrides via env vars", () => {
    const config = parseEnv({
      ...baseEnv,
      POLARIS_HTTP_HOST: "127.0.0.1",
      POLARIS_HTTP_PORT: "9123",
      POLARIS_HTTP_BODY_LIMIT_BYTES: "524288",
    });
    expect(config.http.host).toBe("127.0.0.1");
    expect(config.http.port).toBe(9123);
    expect(config.http.bodyLimitBytes).toBe(524_288);
  });

  it("respects auth cache overrides via env vars", () => {
    const config = parseEnv({
      ...baseEnv,
      POLARIS_AUTH_CACHE_MAX_ENTRIES: "16",
      POLARIS_AUTH_CACHE_TTL_MS: "30000",
      POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS: "1000",
    });
    expect(config.authCache.maxEntries).toBe(16);
    expect(config.authCache.ttlMs).toBe(30_000);
    expect(config.authCache.negativeTtlMs).toBe(1_000);
  });

  it("fails fast when required env vars are missing", () => {
    expect(() =>
      parseEnv({
        // POLARIS_SERVICE_NAME and POLARIS_ENV intentionally missing.
        POLARIS_SERVICE_VERSION: "1.0.0",
        ...basePostgresEnv,
      }),
    ).toThrow(ConfigValidationError);
  });

  it("fails fast when required postgres env vars are missing", () => {
    expect(() =>
      parseEnv({
        POLARIS_SERVICE_NAME: INGESTER_SERVICE_NAME,
        POLARIS_ENV: "local",
        // postgres fields intentionally missing
      }),
    ).toThrow(ConfigValidationError);
  });
});

describe("loadIngesterConfig", () => {
  it("re-exports a working loader bound to the ingester service name", () => {
    const previous = { ...process.env };
    try {
      process.env["POLARIS_SERVICE_NAME"] = INGESTER_SERVICE_NAME;
      process.env["POLARIS_ENV"] = "local";
      process.env["POLARIS_SERVICE_VERSION"] = "9.9.9";
      for (const [k, v] of Object.entries(basePostgresEnv)) {
        process.env[k] = v;
      }
      const config = loadIngesterConfig();
      expect(config.service.serviceName).toBe(INGESTER_SERVICE_NAME);
      expect(config.service.serviceVersion).toBe("9.9.9");
      expect(config.service.environment).toBe("local");
      expect(config.postgres.host).toBe("localhost");
    } finally {
      // Restore the snapshot so other tests in the file aren't affected.
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
