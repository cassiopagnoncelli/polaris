import { describe, expect, it } from "vitest";
import {
  booleanFromStringSchema,
  clickhouseEnvSchema,
  csvListSchema,
  environmentSchema,
  httpEnvSchema,
  portSchema,
  postgresEnvSchema,
  redisEnvSchema,
  redpandaEnvSchema,
  serviceEnvSchema,
} from "../src/index.js";

describe("environmentSchema", () => {
  it("accepts the four declared environments", () => {
    for (const value of ["local", "development", "staging", "production"]) {
      expect(environmentSchema.parse(value)).toBe(value);
    }
  });

  it("rejects unknown values", () => {
    expect(() => environmentSchema.parse("prod")).toThrow();
  });
});

describe("portSchema", () => {
  it("coerces strings", () => {
    expect(portSchema.parse("8080")).toBe(8080);
  });

  it("rejects out-of-range values", () => {
    expect(() => portSchema.parse("0")).toThrow();
    expect(() => portSchema.parse("70000")).toThrow();
  });

  it("rejects non-integers", () => {
    expect(() => portSchema.parse("8080.5")).toThrow();
  });
});

describe("booleanFromStringSchema", () => {
  it("accepts canonical strings", () => {
    expect(booleanFromStringSchema.parse("true")).toBe(true);
    expect(booleanFromStringSchema.parse("FALSE")).toBe(false);
    expect(booleanFromStringSchema.parse("1")).toBe(true);
    expect(booleanFromStringSchema.parse("0")).toBe(false);
    expect(booleanFromStringSchema.parse("yes")).toBe(true);
    expect(booleanFromStringSchema.parse("no")).toBe(false);
    expect(booleanFromStringSchema.parse("on")).toBe(true);
    expect(booleanFromStringSchema.parse("off")).toBe(false);
  });

  it("passes booleans through", () => {
    expect(booleanFromStringSchema.parse(true)).toBe(true);
    expect(booleanFromStringSchema.parse(false)).toBe(false);
  });

  it("rejects garbage", () => {
    expect(() => booleanFromStringSchema.parse("Tru")).toThrow();
  });
});

describe("csvListSchema", () => {
  it("splits comma-separated values and trims", () => {
    expect(csvListSchema.parse(" a , b , c ")).toEqual(["a", "b", "c"]);
  });

  it("drops empty entries", () => {
    expect(csvListSchema.parse("a,,b,")).toEqual(["a", "b"]);
  });

  it("accepts arrays unchanged (after trim)", () => {
    expect(csvListSchema.parse(["a ", " b"])).toEqual(["a", "b"]);
  });
});

describe("serviceEnvSchema", () => {
  it("produces a typed config from required env vars", () => {
    const config = serviceEnvSchema.parse({
      POLARIS_SERVICE_NAME: "ingester-api",
      POLARIS_ENV: "production",
    });
    expect(config).toEqual({
      serviceName: "ingester-api",
      serviceVersion: "0.0.0",
      environment: "production",
      logLevel: "info",
      logPretty: false,
      gitSha: undefined,
      buildTime: undefined,
    });
  });

  it("defaults logPretty to true in local environment", () => {
    const config = serviceEnvSchema.parse({
      POLARIS_SERVICE_NAME: "ingester-api",
      POLARIS_ENV: "local",
    });
    expect(config.logPretty).toBe(true);
  });

  it("rejects missing service name", () => {
    expect(() =>
      serviceEnvSchema.parse({
        POLARIS_ENV: "production",
      }),
    ).toThrow();
  });
});

describe("postgresEnvSchema", () => {
  const baseEnv = {
    POLARIS_POSTGRES_HOST: "db",
    POLARIS_POSTGRES_DATABASE: "polaris",
    POLARIS_POSTGRES_USER: "polaris",
    POLARIS_POSTGRES_PASSWORD: "polaris",
  };

  it("applies sensible defaults", () => {
    const config = postgresEnvSchema.parse(baseEnv);
    expect(config.port).toBe(5432);
    expect(config.ssl).toBe(false);
    expect(config.poolMax).toBe(10);
    expect(config.connectTimeoutMs).toBe(10_000);
    expect(config.idleTimeoutMs).toBe(30_000);
  });

  it("coerces numeric env vars", () => {
    const config = postgresEnvSchema.parse({
      ...baseEnv,
      POLARIS_POSTGRES_PORT: "6543",
      POLARIS_POSTGRES_POOL_MAX: "25",
    });
    expect(config.port).toBe(6543);
    expect(config.poolMax).toBe(25);
  });

  it("rejects missing password", () => {
    expect(() =>
      postgresEnvSchema.parse({
        POLARIS_POSTGRES_HOST: "db",
        POLARIS_POSTGRES_DATABASE: "polaris",
        POLARIS_POSTGRES_USER: "polaris",
      }),
    ).toThrow();
  });
});

describe("redisEnvSchema", () => {
  it("loads minimal redis config", () => {
    const config = redisEnvSchema.parse({ POLARIS_REDIS_HOST: "redis" });
    expect(config).toEqual({
      host: "redis",
      port: 6379,
      db: 0,
      username: undefined,
      password: undefined,
      connectTimeoutMs: 5_000,
      keyPrefix: undefined,
    });
  });

  it("rejects db index above 15", () => {
    expect(() =>
      redisEnvSchema.parse({ POLARIS_REDIS_HOST: "redis", POLARIS_REDIS_DB: "16" }),
    ).toThrow();
  });
});

describe("redpandaEnvSchema", () => {
  it("parses brokers as a list", () => {
    const config = redpandaEnvSchema.parse({
      POLARIS_REDPANDA_BROKERS: "broker1:9092, broker2:9092",
      POLARIS_REDPANDA_CLIENT_ID: "ingester-api",
    });
    expect(config.brokers).toEqual(["broker1:9092", "broker2:9092"]);
    expect(config.sasl).toBeUndefined();
  });

  it("requires SASL username and password when mechanism is set", () => {
    expect(() =>
      redpandaEnvSchema.parse({
        POLARIS_REDPANDA_BROKERS: "broker1:9092",
        POLARIS_REDPANDA_CLIENT_ID: "ingester-api",
        POLARIS_REDPANDA_SASL_MECHANISM: "scram-sha-256",
      }),
    ).toThrow();
  });

  it("accepts a complete SASL config", () => {
    const config = redpandaEnvSchema.parse({
      POLARIS_REDPANDA_BROKERS: "broker1:9092",
      POLARIS_REDPANDA_CLIENT_ID: "ingester-api",
      POLARIS_REDPANDA_SSL: "true",
      POLARIS_REDPANDA_SASL_MECHANISM: "scram-sha-256",
      POLARIS_REDPANDA_SASL_USERNAME: "u",
      POLARIS_REDPANDA_SASL_PASSWORD: "p",
    });
    expect(config.ssl).toBe(true);
    expect(config.sasl).toEqual({
      mechanism: "scram-sha-256",
      username: "u",
      password: "p",
    });
  });

  it("rejects an empty broker list", () => {
    expect(() =>
      redpandaEnvSchema.parse({
        POLARIS_REDPANDA_BROKERS: "",
        POLARIS_REDPANDA_CLIENT_ID: "ingester-api",
      }),
    ).toThrow();
  });
});

describe("clickhouseEnvSchema", () => {
  const baseEnv = {
    POLARIS_CLICKHOUSE_URL: "http://clickhouse:8123",
    POLARIS_CLICKHOUSE_DATABASE: "default",
    POLARIS_CLICKHOUSE_SERVICE_USER: "polaris_service",
    POLARIS_CLICKHOUSE_SERVICE_PASSWORD: "secret",
  };

  it("parses required fields", () => {
    const config = clickhouseEnvSchema.parse(baseEnv);
    expect(config.url).toBe("http://clickhouse:8123");
    expect(config.service.user).toBe("polaris_service");
    expect(config.operator).toBeUndefined();
  });

  it("rejects a non-HTTP URL", () => {
    expect(() =>
      clickhouseEnvSchema.parse({
        ...baseEnv,
        POLARIS_CLICKHOUSE_URL: "tcp://clickhouse:9000",
      }),
    ).toThrow();
  });

  it("rejects half-set operator credentials", () => {
    expect(() =>
      clickhouseEnvSchema.parse({
        ...baseEnv,
        POLARIS_CLICKHOUSE_OPERATOR_USER: "polaris_operator",
      }),
    ).toThrow();
  });

  it("accepts a complete operator pair", () => {
    const config = clickhouseEnvSchema.parse({
      ...baseEnv,
      POLARIS_CLICKHOUSE_OPERATOR_USER: "polaris_operator",
      POLARIS_CLICKHOUSE_OPERATOR_PASSWORD: "opsecret",
    });
    expect(config.operator).toEqual({
      user: "polaris_operator",
      password: "opsecret",
    });
  });
});

describe("httpEnvSchema", () => {
  it("uses defaults", () => {
    const config = httpEnvSchema.parse({});
    expect(config).toEqual({
      host: "0.0.0.0",
      port: 3000,
      bodyLimitBytes: 1_048_576,
      requestTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
    });
  });

  it("respects overrides", () => {
    const config = httpEnvSchema.parse({
      POLARIS_HTTP_PORT: "8081",
      POLARIS_HTTP_BODY_LIMIT_BYTES: "2048",
    });
    expect(config.port).toBe(8081);
    expect(config.bodyLimitBytes).toBe(2048);
  });
});
