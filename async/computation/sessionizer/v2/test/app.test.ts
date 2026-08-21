/**
 * Bootstrap tests for sessionizer v1 — processor run registration.
 *
 * The app registers a `processor_runs` row at boot and closes it out on
 * shutdown, and the id of that row is what every derived event carries in
 * `processor.run_id`. Before this wiring the runtime fabricated the id, so
 * derived events referenced runs that did not exist.
 *
 * RabbitMQ and PostgreSQL stay out of it: the consumer/producer are stubs and
 * the run repository is the in-memory adapter.
 */

import { InMemoryProcessorRunRepository, type ProcessorRunHandle } from "@polaris/pipeline";
import type { PolarisConsumer, PolarisProducer, PublishEventInput } from "@polaris/bus";
import { describe, expect, it, vi } from "vitest";

import { buildSessionizerApp } from "../src/app.js";
import type { SessionizerRuntimeConfig } from "../src/config.js";
import { InMemorySessionStore } from "../src/store.js";
import { DEFAULT_INACTIVITY_SECONDS } from "../src/transform.js";

const TEST_CONFIG: SessionizerRuntimeConfig = {
  service: {
    serviceName: "sessionizer",
    serviceVersion: "0.0.1",
    environment: "local",
    logLevel: "info",
    logPretty: false,
    gitSha: "deadbee",
    buildTime: "2026-05-12T10:00:00.000Z",
    releaseLabel: "test",
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
    clientId: "sessionizer-test",
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
  redis: {
    host: "127.0.0.1",
    port: 6379,
    db: 0,
    username: undefined,
    password: undefined,
    connectTimeoutMs: 1_000,
    keyPrefix: "polaris:test",
  },
  sessionizer: {
    consumerGroup: "polaris-sessionizer-v2-test",
    inactivitySeconds: 1800,
    redisKeyPrefix: "polaris:sessionizer:v2:test",
    redisOpTimeoutMs: 1_000,
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
      stream: "derived-0",
      partition: 0,
    })),
    publish: vi.fn(async () => ({ stream: "derived-0", partition: 0 })),
    publishToQueue: vi.fn(async () => undefined),
  };
}

async function build(runs: InMemoryProcessorRunRepository, installShutdown = false) {
  return buildSessionizerApp({
    // No live PostgreSQL in this suite. Without it, `startIsolationSnapshot`
    // reads `topic_isolations` at boot and its FIRST read must succeed —
    // deliberately, since serving an empty snapshot would reroute every
    // isolated project's traffic. Supplying the list is the seam that skips
    // it. `c6a0507` wired the snapshot in and left these tests depending on
    // a database that happened to be running on the author's machine; CI
    // was dead at the time, so nothing said so for a day.
    isolatedProjects: [],
    config: TEST_CONFIG,
    installShutdown,
    ...(installShutdown ? { shutdownExit: () => {} } : {}),
    consumer: stubConsumer(),
    producer: stubProducer(),
    startRuntime: false,
    runRepository: runs,
    store: new InMemorySessionStore(),
  });
}

describe("buildSessionizerApp run registration", () => {
  it("registers a processor_runs row for this process", async () => {
    const runs = new InMemoryProcessorRunRepository();
    const result = await build(runs);
    try {
      const run: ProcessorRunHandle = result.run;
      expect(run.registered).toBe(true);

      const row = await runs.findRun(run.run_id);
      expect(row?.processor_name).toBe("sessionizer");
      expect(row?.processor_version).toBe("v2");
      expect(row?.status).toBe("running");
      // `local` is a deployment label, not one of the control plane's three
      // environments, so the run is recorded unscoped rather than failing the
      // `processor_runs_environment_allowed` CHECK.
      expect(row?.environment).toBeNull();
      // Cross-project: the processor reads every project's events off the
      // shared stream.
      expect(row?.project_id).toBeNull();
      // Not a `synthetic:` placeholder — this id joins to the row above.
      expect(run.run_id).not.toContain("synthetic");
    } finally {
      await result.bootstrap.app.close();
    }
  });

  it("closes the run out on shutdown", async () => {
    const runs = new InMemoryProcessorRunRepository();
    const result = await build(runs, true);
    const runId = result.run.run_id;

    await result.bootstrap.shutdown("SIGTERM");

    const row = await runs.findRun(runId);
    expect(row?.status).toBe("completed");
    expect(row?.finished_at).not.toBeNull();
  });
});

describe("buildSessionizerApp activation gate", () => {
  it("threads the gate into the runtime, so a disable reaches the message path", async () => {
    // Proves the app→runtime wiring, not just that a gate object exists: a
    // gate the app forgot to pass would never be asked anything.
    const asked: Array<{ project_id: string; environment: string }> = [];
    const runs = new InMemoryProcessorRunRepository();
    const result = await buildSessionizerApp({
      // No live PostgreSQL in this suite. Without it, `startIsolationSnapshot`
      // reads `topic_isolations` at boot and its FIRST read must succeed —
      // deliberately, since serving an empty snapshot would reroute every
      // isolated project's traffic. Supplying the list is the seam that skips
      // it. `c6a0507` wired the snapshot in and left these tests depending on
      // a database that happened to be running on the author's machine; CI
      // was dead at the time, so nothing said so for a day.
      isolatedProjects: [],
      config: TEST_CONFIG,
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
      runRepository: runs,
      store: new InMemorySessionStore(),
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

describe("buildSessionizerApp inactivity window", () => {
  it("uses the manifest window even when env asks for a different one", async () => {
    // The window is semantic. This used to be a promise in a comment while
    // the configured value was passed straight through in both directions,
    // so a deployment could silently run semantics that were not v1's.
    const runs = new InMemoryProcessorRunRepository();
    const app = await buildSessionizerApp({
      // No live PostgreSQL in this suite. Without it, `startIsolationSnapshot`
      // reads `topic_isolations` at boot and its FIRST read must succeed —
      // deliberately, since serving an empty snapshot would reroute every
      // isolated project's traffic. Supplying the list is the seam that skips
      // it. `c6a0507` wired the snapshot in and left these tests depending on
      // a database that happened to be running on the author's machine; CI
      // was dead at the time, so nothing said so for a day.
      isolatedProjects: [],
      config: {
        ...TEST_CONFIG,
        sessionizer: { ...TEST_CONFIG.sessionizer, inactivitySeconds: 86_400 },
      },
      installShutdown: false,
      consumer: stubConsumer(),
      producer: stubProducer(),
      startRuntime: false,
      runRepository: runs,
      store: new InMemorySessionStore(),
    });
    try {
      expect(app.runtime.inactivitySeconds).toBe(DEFAULT_INACTIVITY_SECONDS);
      expect(app.runtime.inactivitySeconds).not.toBe(86_400);
    } finally {
      await app.bootstrap.shutdown();
    }
  });

  it("uses the manifest window when env mirrors it", async () => {
    const runs = new InMemoryProcessorRunRepository();
    const app = await build(runs);
    try {
      expect(app.runtime.inactivitySeconds).toBe(DEFAULT_INACTIVITY_SECONDS);
    } finally {
      await app.bootstrap.shutdown();
    }
  });
});
