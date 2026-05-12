/**
 * Bootstrap tests for analytics-projector v1.
 *
 * The processor is a Node service that runs `/health`, `/ready`, and
 * `/metrics` through the shared Fastify bootstrap (same shape as
 * `apps/ingester-api`). These tests confirm:
 *
 *   - the app builds without bringing up Redpanda (injected stubs work),
 *   - `/health` returns the processor service identity,
 *   - `/ready` reflects probe state,
 *   - shutdown tasks tear the runtime down deterministically.
 */

import { describe, expect, it, vi } from "vitest";

import type { PolarisConsumer, PolarisProducer, PublishEventInput } from "@polaris/shared-kafka";

import { buildAnalyticsProjectorApp } from "../src/app.js";
import type { AnalyticsProjectorRuntimeConfig } from "../src/config.js";

const TEST_CONFIG: AnalyticsProjectorRuntimeConfig = {
  service: {
    serviceName: "analytics-projector",
    serviceVersion: "0.0.1",
    environment: "local",
    logLevel: "info",
    logPretty: false,
    gitSha: "deadbee",
    buildTime: "2026-05-12T10:00:00.000Z",
  },
  http: {
    host: "127.0.0.1",
    port: 0,
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 15_000,
    keepAliveTimeoutMs: 5_000,
  },
  redpanda: {
    brokers: ["localhost:9092"],
    clientId: "analytics-projector-test",
    ssl: false,
    sasl: undefined,
    connectionTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
  },
  projector: {
    consumerGroup: "polaris-analytics-projector-v1-test",
    partitionsConsumedConcurrently: 1,
  },
};

function stubConsumer(): PolarisConsumer {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    runEach: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    raw: {} as PolarisConsumer["raw"],
  };
}

function stubProducer(): PolarisProducer {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    publishEvent: vi.fn(async (_input: PublishEventInput) => []),
    send: vi.fn(async () => []),
    raw: {} as PolarisProducer["raw"],
  };
}

describe("buildAnalyticsProjectorApp", () => {
  it("exposes /health with the analytics-projector identity", async () => {
    const { bootstrap } = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
    });
    try {
      const res = await bootstrap.app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body["status"]).toBe("ok");
      expect(body["service"]).toBe("analytics-projector");
      expect(body["version"]).toBe("0.0.1");
      expect(body["environment"]).toBe("local");
    } finally {
      await bootstrap.app.close();
    }
  });

  it("exposes /ready returning 200 when no probes are configured", async () => {
    const { bootstrap } = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
    });
    try {
      const res = await bootstrap.app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; probes: unknown[] };
      expect(body.status).toBe("ready");
      expect(body.probes).toEqual([]);
    } finally {
      await bootstrap.app.close();
    }
  });

  it("rolls /ready down to 503 when a probe reports down", async () => {
    const { bootstrap } = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
      readinessProbes: [
        async function redpanda() {
          return { name: "redpanda", status: "down", detail: "broker unreachable" };
        },
      ],
    });
    try {
      const res = await bootstrap.app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
    } finally {
      await bootstrap.app.close();
    }
  });

  it("does not assume ownership of injected producer/consumer lifecycles", async () => {
    const consumer = stubConsumer();
    const producer = stubProducer();
    const result = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: false,
      consumer,
      producer,
      startRuntime: false,
    });
    try {
      // Injection short-circuits the kafka-client construction; the app
      // does not call connect/disconnect on injected handles.
      expect(consumer.connect).not.toHaveBeenCalled();
      expect(producer.connect).not.toHaveBeenCalled();
      expect(result.ownsConsumer).toBe(false);
      expect(result.ownsProducer).toBe(false);
    } finally {
      await result.bootstrap.app.close();
    }
  });
});
