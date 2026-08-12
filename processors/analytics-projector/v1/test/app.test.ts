/**
 * Bootstrap tests for analytics-projector v1.
 *
 * The processor is a Node service that runs `/health`, `/ready`, and
 * `/metrics` through the shared Fastify bootstrap (same shape as
 * `apps/ingester-api`). These tests confirm:
 *
 *   - the app builds without bringing up RabbitMQ (injected stubs work),
 *   - `/health` returns the processor service identity,
 *   - `/ready` reflects probe state,
 *   - shutdown tasks tear the runtime down deterministically.
 */

import { InMemoryProcessorRunRepository, type ProcessorRunHandle } from "@polaris/shared-processor";
import type {
  PolarisConsumer,
  PolarisProducer,
  PublishEventInput,
} from "@polaris/shared-transport";
import { describe, expect, it, vi } from "vitest";

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
  rabbitmq: {
    url: "amqp://polaris:polaris@localhost:5672",
    managementUrl: undefined,
    clientId: "analytics-projector-test",
    tls: false,
    heartbeatSeconds: 30,
    connectionTimeoutMs: 10_000,
    partitions: 3,
    partitionOverrides: {},
    assignedPartitions: [],
    prefetch: 100,
    checkpointIntervalMs: 5_000,
    checkpointEvery: 500,
    streamRetentionDays: 90,
  },
  // Checkpoints only — the projector writes no control-plane state, but a
  // stream consumer owns its own resume point now.
  postgres: {
    host: "localhost",
    port: 5432,
    database: "polaris",
    user: "polaris",
    password: "polaris",
    ssl: false,
    poolMax: 10,
    connectTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
  },
  projector: {
    consumerGroup: "polaris-analytics-projector-v1-test",
  },
};

/** Minimal canonical envelope — enough to decode and reach the gate. */
const RAW_ENVELOPE = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  event: "page.viewed",
  schema_version: 1,
  project_id: "checkout",
  environment: "production",
  occurred_at: "2026-05-12T12:00:00.000Z",
  ingested_at: "2026-05-12T12:00:01.000Z",
  source: { type: "browser", id: "web", sdk: "web", sdk_version: "1.0.0" },
  identity: { anonymous_id: "anon_X", session_id: null, customer_id: null, device_id: null },
  context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
  properties: {},
};

function stubConsumer(): PolarisConsumer {
  return {
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    runEach: vi.fn(async () => {}),
    streams: [],
    queues: [],
  };
}

function stubProducer(): PolarisProducer {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    publishEvent: vi.fn(async (_input: PublishEventInput) => ({
      stream: "analytics.events-0",
      partition: 0,
    })),
    publish: vi.fn(async () => ({ stream: "analytics.events-0", partition: 0 })),
    publishToQueue: vi.fn(async () => undefined),
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
      recordRun: false,
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
      recordRun: false,
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
      recordRun: false,
      readinessProbes: [
        async function rabbitmq() {
          return { name: "rabbitmq", status: "down", detail: "broker unreachable" };
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
      recordRun: false,
    });
    try {
      // Injection short-circuits the transport construction; the app does
      // not touch the lifecycle of injected handles. The consumer has no
      // connect() of its own any more — the shared connection owns that —
      // so ownership is asserted through the subscribe/disconnect pair.
      expect(consumer.subscribe).not.toHaveBeenCalled();
      expect(consumer.disconnect).not.toHaveBeenCalled();
      expect(producer.connect).not.toHaveBeenCalled();
      expect(result.ownsConsumer).toBe(false);
      expect(result.ownsProducer).toBe(false);
    } finally {
      await result.bootstrap.app.close();
    }
  });
});

describe("buildAnalyticsProjectorApp run registration", () => {
  it("registers a processor_runs row and hands its id to the runtime", async () => {
    const runs = new InMemoryProcessorRunRepository();
    const result = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
      runRepository: runs,
    });
    try {
      expect(result.run).not.toBeNull();
      const run = result.run as ProcessorRunHandle;
      expect(run.registered).toBe(true);

      const row = await runs.findRun(run.run_id);
      expect(row?.processor_name).toBe("analytics-projector");
      expect(row?.processor_version).toBe("v1");
      expect(row?.status).toBe("running");
      // `local` is a deployment label, not one of the control plane's three
      // environments, so the run is recorded unscoped rather than failing the
      // `processor_runs_environment_allowed` CHECK.
      expect(row?.environment).toBeNull();
      // Cross-project by construction: the projector reads every project's
      // events off the shared stream.
      expect(row?.project_id).toBeNull();
      // The id stamped on derived events is the id of the row, not a
      // `synthetic:` placeholder.
      expect(run.run_id).not.toContain("synthetic");
    } finally {
      await result.bootstrap.app.close();
    }
  });

  it("closes the run out on shutdown", async () => {
    const runs = new InMemoryProcessorRunRepository();
    // `installShutdown: true` is required for `bootstrap.shutdown()` to do
    // anything — with it false the handle is a no-op stub. `shutdownExit`
    // keeps the shutdown path from calling `process.exit` under vitest.
    const result = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: true,
      shutdownExit: () => {},
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
      runRepository: runs,
    });
    const run = result.run as ProcessorRunHandle;

    await result.bootstrap.shutdown("SIGTERM");

    const row = await runs.findRun(run.run_id);
    expect(row?.status).toBe("completed");
    expect(row?.finished_at).not.toBeNull();
  });

  it("still allocates a run id when recording is disabled, but records no row", async () => {
    // Every derived event schema declares `run_id` as required, so there is
    // always an id. `registered` is what says whether it joins to a row.
    const result = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
      recordRun: false,
    });
    try {
      expect(result.run.registered).toBe(false);
      expect(result.run.run_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // Terminal calls are safe with nothing to write to.
      await expect(result.run.complete()).resolves.toBeUndefined();
    } finally {
      await result.bootstrap.app.close();
    }
  });
});

describe("buildAnalyticsProjectorApp activation gate", () => {
  it("threads the gate into the runtime, so a disable reaches the message path", async () => {
    // Proves the app→runtime wiring, not just that a gate object exists: a
    // gate the app forgot to pass would never be asked anything.
    const asked: Array<{ project_id: string; environment: string }> = [];
    const runs = new InMemoryProcessorRunRepository();
    const result = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
      runRepository: runs,
      gate: {
        isEnabled: async (scope) => {
          asked.push(scope);
          return false;
        },
      },
    });
    try {
      await result.runtime.handler(
        {
          stream: "raw.events-0",
          partition: 0,
          message: {
            key: "k",
            value: Buffer.from(JSON.stringify(RAW_ENVELOPE), "utf8"),
            offset: "1",
            headers: {},
            timestamp: "0",
            redelivered: false,
          },
        } as never,
        {} as never,
      );
    } finally {
      await result.bootstrap.app.close();
    }

    expect(asked).toEqual([{ project_id: "checkout", environment: "production" }]);
  });
});

describe("buildAnalyticsProjectorApp readiness", () => {
  it("drops /ready when a probe reports the transport down", async () => {
    // `/ready` answered an unconditional 200 for every processor: no probe was
    // registered here or by main.ts, so a pod with a dead producer reported
    // itself ready and kept claiming partitions it could not serve.
    const result = await buildAnalyticsProjectorApp({
      config: TEST_CONFIG,
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
      recordRun: false,
      readinessProbes: [
        async () => ({ name: "rabbitmq", status: "down" as const, detail: "connection is down" }),
      ],
    });
    try {
      const res = await result.bootstrap.app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
    } finally {
      await result.bootstrap.app.close();
    }
  });
});
