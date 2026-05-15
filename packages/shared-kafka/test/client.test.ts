import { describe, expect, it } from "vitest";

import { createKafkaClient, DEFAULT_RETRY_OPTIONS } from "../src/client.js";

const REDPANDA_BASE = {
  brokers: ["localhost:9092"],
  clientId: "test-client",
  ssl: false,
  sasl: undefined,
  connectionTimeoutMs: 5000,
  requestTimeoutMs: 10000,
} as const;

describe("createKafkaClient", () => {
  it("constructs a KafkaJS client with the given Redpanda config", () => {
    const kafka = createKafkaClient({ redpanda: REDPANDA_BASE });
    // KafkaJS exposes producer/consumer factories. Smoke-test that the
    // client instance is shaped correctly without actually connecting.
    expect(typeof kafka.producer).toBe("function");
    expect(typeof kafka.consumer).toBe("function");
    expect(typeof kafka.admin).toBe("function");
  });

  it("accepts SASL credentials when configured", () => {
    const kafka = createKafkaClient({
      redpanda: {
        ...REDPANDA_BASE,
        sasl: {
          mechanism: "scram-sha-256",
          username: "u",
          password: "p",
        },
      },
    });
    expect(typeof kafka.producer).toBe("function");
  });

  it("accepts SSL and timeout overrides via kafkaConfig", () => {
    const kafka = createKafkaClient({
      redpanda: { ...REDPANDA_BASE, ssl: true },
      kafkaConfig: { connectionTimeout: 1234 },
    });
    expect(typeof kafka.producer).toBe("function");
  });

  it("exposes a frozen default retry policy", () => {
    expect(Object.isFrozen(DEFAULT_RETRY_OPTIONS)).toBe(true);
    expect(DEFAULT_RETRY_OPTIONS.retries).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_OPTIONS.initialRetryTime).toBeGreaterThan(0);
  });
});
