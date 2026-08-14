import { describe, expect, it } from "vitest";
import {
  booleanFromStringSchema,
  clickhouseEnvSchema,
  csvListSchema,
  environmentSchema,
  httpEnvSchema,
  parsePartitionOverrides,
  partitionsForFamily,
  portSchema,
  postgresEnvSchema,
  rabbitmqEnvSchema,
  redisEnvSchema,
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
      releaseLabel: undefined,
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

  it("prefers POLARIS_SERVICE_VERSION when both env vars are set", () => {
    const config = serviceEnvSchema.parse({
      POLARIS_SERVICE_NAME: "ingester-api",
      POLARIS_ENV: "production",
      POLARIS_SERVICE_VERSION: "1.2.3",
      POLARIS_BUILD_VERSION: "9.9.9",
    });
    expect(config.serviceVersion).toBe("1.2.3");
  });

  it("falls back to POLARIS_BUILD_VERSION when POLARIS_SERVICE_VERSION is unset", () => {
    const config = serviceEnvSchema.parse({
      POLARIS_SERVICE_NAME: "ingester-api",
      POLARIS_ENV: "production",
      POLARIS_BUILD_VERSION: "0.4.2-rc1",
    });
    expect(config.serviceVersion).toBe("0.4.2-rc1");
  });

  it("surfaces release label, git sha, and build time when set", () => {
    const config = serviceEnvSchema.parse({
      POLARIS_SERVICE_NAME: "ingester-api",
      POLARIS_ENV: "production",
      POLARIS_GIT_SHA: "abc1234",
      POLARIS_BUILD_TIME: "2026-05-12T10:00:00.000Z",
      POLARIS_RELEASE_LABEL: "2026-q2-r1",
    });
    expect(config.gitSha).toBe("abc1234");
    expect(config.buildTime).toBe("2026-05-12T10:00:00.000Z");
    expect(config.releaseLabel).toBe("2026-q2-r1");
  });

  it("leaves release label undefined when env var is absent", () => {
    const config = serviceEnvSchema.parse({
      POLARIS_SERVICE_NAME: "ingester-api",
      POLARIS_ENV: "production",
    });
    expect(config.releaseLabel).toBeUndefined();
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

describe("rabbitmqEnvSchema", () => {
  const baseEnv = {
    POLARIS_RABBITMQ_URL: "amqp://polaris:polaris@rabbitmq:5672/%2F",
    POLARIS_RABBITMQ_CLIENT_ID: "ingester-api",
  };

  it("parses the minimal config with sane defaults", () => {
    const config = rabbitmqEnvSchema.parse(baseEnv);
    expect(config.url).toBe("amqp://polaris:polaris@rabbitmq:5672/%2F");
    expect(config.partitions).toBe(3);
    expect(config.partitionOverrides).toEqual({});
    // Empty assignment means "this instance owns every partition", which
    // is the right default for single-instance and local runs.
    expect(config.assignedPartitions).toEqual([]);
    expect(config.streamRetentionDays).toBe(90);
  });

  it("rejects a URL that is not AMQP", () => {
    expect(() =>
      rabbitmqEnvSchema.parse({ ...baseEnv, POLARIS_RABBITMQ_URL: "http://rabbitmq:15672" }),
    ).toThrow();
  });

  it("rejects TLS enabled against a plaintext URL", () => {
    // Silently running unencrypted while believing TLS is on is the
    // failure this guard exists for.
    expect(() => rabbitmqEnvSchema.parse({ ...baseEnv, POLARIS_RABBITMQ_TLS: "true" })).toThrow();
  });

  it("accepts TLS with an amqps URL", () => {
    const config = rabbitmqEnvSchema.parse({
      ...baseEnv,
      POLARIS_RABBITMQ_URL: "amqps://polaris:polaris@rabbitmq:5671/%2F",
      POLARIS_RABBITMQ_TLS: "true",
    });
    expect(config.tls).toBe(true);
  });

  it("parses per-family partition overrides", () => {
    const config = rabbitmqEnvSchema.parse({
      ...baseEnv,
      POLARIS_RABBITMQ_PARTITION_OVERRIDES: "raw.events=6, analytics.events=4",
    });
    expect(config.partitionOverrides).toEqual({ "raw.events": 6, "analytics.events": 4 });
  });

  it("rejects a malformed partition override", () => {
    expect(() =>
      rabbitmqEnvSchema.parse({
        ...baseEnv,
        POLARIS_RABBITMQ_PARTITION_OVERRIDES: "raw.events=zero",
      }),
    ).toThrow();
  });

  it("parses, dedupes, and sorts the static partition assignment", () => {
    const config = rabbitmqEnvSchema.parse({
      ...baseEnv,
      POLARIS_RABBITMQ_ASSIGNED_PARTITIONS: "2, 0, 2",
    });
    expect(config.assignedPartitions).toEqual([0, 2]);
  });

  it("rejects an assignment outside the widest configured super stream", () => {
    expect(() =>
      rabbitmqEnvSchema.parse({
        ...baseEnv,
        POLARIS_RABBITMQ_PARTITIONS: "3",
        POLARIS_RABBITMQ_ASSIGNED_PARTITIONS: "5",
      }),
    ).toThrow();
  });

  it("allows an assignment that only fits an overridden family", () => {
    const config = rabbitmqEnvSchema.parse({
      ...baseEnv,
      POLARIS_RABBITMQ_PARTITIONS: "3",
      POLARIS_RABBITMQ_PARTITION_OVERRIDES: "raw.events=6",
      POLARIS_RABBITMQ_ASSIGNED_PARTITIONS: "5",
    });
    expect(config.assignedPartitions).toEqual([5]);
  });
});

describe("partitionsForFamily", () => {
  const config = rabbitmqEnvSchema.parse({
    POLARIS_RABBITMQ_URL: "amqp://rabbitmq:5672",
    POLARIS_RABBITMQ_CLIENT_ID: "svc",
    POLARIS_RABBITMQ_PARTITIONS: "3",
    POLARIS_RABBITMQ_PARTITION_OVERRIDES: "raw.events=6",
  });

  it("returns the override when the family has one", () => {
    expect(partitionsForFamily(config, "raw.events")).toBe(6);
  });

  it("falls back to the global default", () => {
    expect(partitionsForFamily(config, "analytics.events")).toBe(3);
  });

  it("inherits the parent family's width for a dedicated per-project stream", () => {
    // An isolated project must keep the ordering guarantees of the shared
    // stream it graduated from.
    expect(partitionsForFamily(config, "raw.events.project-alpha")).toBe(6);
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

describe("parsePartitionOverrides (shared with the provisioning script)", () => {
  // Partition width is a wire contract: the publisher hashes the key modulo
  // the width, so a provisioner parsing this string even slightly
  // differently from the services would create streams of one width while
  // producers addressed another — broken per-identity ordering, no error
  // anywhere. `scripts/rabbitmq-provision.mjs` carried its own copy until
  // the spine families were added; these cases pin the single implementation
  // both now use.
  it("parses the shipped default covering raw and both spine families", () => {
    const { overrides, problems } = parsePartitionOverrides(
      "raw.events=6,identified.events=6,resolved.events=6",
    );
    expect(problems).toEqual([]);
    expect(overrides).toEqual({
      "raw.events": 6,
      "identified.events": 6,
      "resolved.events": 6,
    });
  });

  it("returns an empty map for an empty string rather than failing", () => {
    expect(parsePartitionOverrides("").overrides).toEqual({});
    expect(parsePartitionOverrides("   ").problems).toEqual([]);
  });

  it("tolerates whitespace and a trailing separator", () => {
    const { overrides, problems } = parsePartitionOverrides(" raw.events = 6 , ");
    expect(problems).toEqual([]);
    expect(overrides).toEqual({ "raw.events": 6 });
  });

  it("reports malformed entries instead of silently dropping them", () => {
    // Silently ignoring a typo is the dangerous behaviour: the family would
    // quietly fall back to the default width while the operator believes
    // the override applied.
    for (const bad of ["raw.events", "=6", "raw.events=0", "raw.events=two", "raw.events=1.5"]) {
      expect(parsePartitionOverrides(bad).problems.length).toBeGreaterThan(0);
    }
  });

  it("splits on the last equals sign", () => {
    expect(parsePartitionOverrides("weird=family=4").overrides).toEqual({ "weird=family": 4 });
  });

  it("agrees with the Zod schema it backs", () => {
    const raw = "raw.events=6,resolved.events=6";
    const viaSchema = rabbitmqEnvSchema.parse({
      POLARIS_RABBITMQ_URL: "amqp://polaris:polaris@rabbitmq:5672/%2F",
      POLARIS_RABBITMQ_CLIENT_ID: "test-client",
      POLARIS_RABBITMQ_PARTITION_OVERRIDES: raw,
    });
    expect(viaSchema.partitionOverrides).toEqual(parsePartitionOverrides(raw).overrides);
  });
});
