import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigValidationError,
  composeConfigSchema,
  loadConfig,
  loadConfigWithDefaults,
  postgresEnvSchema,
  serviceEnvSchema,
} from "../src/index.js";

const fullServiceConfigSchema = composeConfigSchema({
  service: serviceEnvSchema,
  postgres: postgresEnvSchema,
});

describe("loadConfig", () => {
  it("returns the parsed config when env vars are valid", () => {
    const config = loadConfig({
      serviceName: "ingester-api",
      schema: fullServiceConfigSchema,
      env: {
        POLARIS_SERVICE_NAME: "ingester-api",
        POLARIS_ENV: "production",
        POLARIS_POSTGRES_HOST: "db",
        POLARIS_POSTGRES_DATABASE: "polaris",
        POLARIS_POSTGRES_USER: "polaris",
        POLARIS_POSTGRES_PASSWORD: "polaris",
      },
    });
    expect(config.service.serviceName).toBe("ingester-api");
    expect(config.service.environment).toBe("production");
    expect(config.postgres.host).toBe("db");
  });

  it("throws ConfigValidationError on missing required values", () => {
    expect(() =>
      loadConfig({
        serviceName: "ingester-api",
        schema: fullServiceConfigSchema,
        env: {
          POLARIS_ENV: "production",
        },
      }),
    ).toThrow(ConfigValidationError);
  });

  it("attaches every issue to the error", () => {
    let caught: unknown;
    try {
      loadConfig({
        serviceName: "ingester-api",
        schema: fullServiceConfigSchema,
        env: {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const err = caught as ConfigValidationError;
    expect(err.serviceName).toBe("ingester-api");
    expect(err.issues.length).toBeGreaterThan(1);
    expect(err.message).toContain("ingester-api");
    expect(err.message).toContain("POLARIS_SERVICE_NAME");
  });

  it("fails fast on the first invalid field", () => {
    const schema = z.object({ POLARIS_MAGIC: z.string().min(1) });
    expect(() =>
      loadConfig({
        serviceName: "test-svc",
        schema,
        env: { POLARIS_MAGIC: "" },
      }),
    ).toThrow(ConfigValidationError);
  });

  it("ignores undefined env values", () => {
    expect(() =>
      loadConfig({
        serviceName: "test-svc",
        schema: z.object({ POLARIS_OPT: z.string().optional() }),
        env: { POLARIS_OPT: undefined },
      }),
    ).not.toThrow();
  });
});

describe("loadConfigWithDefaults", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-loader-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads .env files in priority order", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "POLARIS_SERVICE_NAME=ingester-api",
        "POLARIS_ENV=development",
        "POLARIS_POSTGRES_HOST=db",
        "POLARIS_POSTGRES_DATABASE=polaris",
        "POLARIS_POSTGRES_USER=polaris",
        "POLARIS_POSTGRES_PASSWORD=base-secret",
      ].join("\n"),
    );
    writeFileSync(join(dir, ".env.development.local"), "POLARIS_POSTGRES_PASSWORD=dev-secret\n");

    const config = loadConfigWithDefaults({
      serviceName: "ingester-api",
      schema: fullServiceConfigSchema,
      cwd: dir,
      processEnv: { POLARIS_ENV: "development" },
    });

    expect(config.postgres.password).toBe("dev-secret");
    expect(config.postgres.user).toBe("polaris");
  });

  it("does not load env-suffixed files when POLARIS_ENV is unset", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "POLARIS_SERVICE_NAME=ingester-api",
        "POLARIS_ENV=development",
        "POLARIS_POSTGRES_HOST=db",
        "POLARIS_POSTGRES_DATABASE=polaris",
        "POLARIS_POSTGRES_USER=polaris",
        "POLARIS_POSTGRES_PASSWORD=base-secret",
      ].join("\n"),
    );
    writeFileSync(join(dir, ".env.production"), "POLARIS_POSTGRES_PASSWORD=should-not-load\n");

    const config = loadConfigWithDefaults({
      serviceName: "ingester-api",
      schema: fullServiceConfigSchema,
      cwd: dir,
      processEnv: {},
    });

    expect(config.postgres.password).toBe("base-secret");
  });
});

describe("ConfigValidationError", () => {
  it("formats issues into a readable multi-line message", () => {
    let caught: ConfigValidationError | undefined;
    try {
      loadConfig({
        serviceName: "test",
        schema: z.object({
          POLARIS_FOO: z.string(),
          POLARIS_BAR: z.coerce.number().int(),
        }),
        env: { POLARIS_BAR: "not-a-number" },
      });
    } catch (err) {
      if (err instanceof ConfigValidationError) caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const message = caught?.message ?? "";
    expect(message).toContain("test");
    expect(message).toContain("POLARIS_FOO");
    expect(message).toContain("POLARIS_BAR");
  });
});
