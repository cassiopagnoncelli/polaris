/**
 * Service bootstrap for clickhouse-sink v1.
 *
 *   1. Structured logger from `@polaris/shared-logger`.
 *   2. PostgreSQL Kysely client — checkpoints only. The sink writes no
 *      control-plane state; it needs Postgres solely because RabbitMQ
 *      streams consumed over AMQP have no server-side offset store.
 *   3. Supervised AMQP connection + `PolarisConsumer` on
 *      `analytics.events`.
 *   4. ClickHouse sink writer authenticating as `polaris_sink`.
 *   5. `bootstrapService` for `/health`, `/ready`, `/metrics`, and an
 *      ordered shutdown: stop the runtime (which flushes the open batch),
 *      close the transport, then end the Postgres pool.
 *
 * Tests inject the consumer and writer through `BuildAppOptions` so the
 * runtime can be driven without a broker or a ClickHouse server.
 *
 * @see docs/architecture/07-clickhouse.md
 * @see async/warehouse/clickhouse-sink/v1/src/runtime.ts
 */

import { type AnalyticsSinkWriter, createAnalyticsSinkWriter } from "@polaris/shared-clickhouse";
import { closeDb, createDb, type Database } from "@polaris/shared-db";
import { createLogger } from "@polaris/shared-logger";
import { toPrometheusText } from "@polaris/shared-metrics";
import {
  type BootstrappedService,
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";
import {
  type CheckpointStore,
  createPolarisConsumer,
  createPolarisProducer,
  createTransportConnection,
  createTransportLogHooks,
  DeferredCheckpointStore,
  InMemoryCheckpointStore,
  type PolarisConsumer,
  type PolarisProducer,
  PostgresCheckpointStore,
  type TransportConnection,
} from "@polaris/shared-transport";
import type { Kysely } from "kysely";

import { type ClickhouseSinkRuntimeConfig, SINK_COMPONENT, SINK_SERVICE_NAME } from "./config.js";
import { SinkMetrics } from "./metrics.js";
import { type ClickhouseSinkRuntime, createRuntime } from "./runtime.js";

export interface BuildAppOptions {
  readonly config: ClickhouseSinkRuntimeConfig;
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;
  /** Pre-built consumer. The caller owns its lifecycle when supplied. */
  readonly consumer?: PolarisConsumer;
  /** Pre-built ClickHouse writer. The caller owns its lifecycle. */
  readonly writer?: AnalyticsSinkWriter;
  /** Pre-built Kysely client. Not closed on shutdown when supplied. */
  readonly db?: Kysely<Database>;
  /**
   * Underlying checkpoint store. Defaults to the Postgres one; tests pass
   * an in-memory store. It is wrapped in a `DeferredCheckpointStore`
   * either way — the sink's durability contract depends on that wrapper.
   */
  readonly checkpoints?: CheckpointStore;
  /** Projects currently isolated for `analytics.events`. */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Start the runtime after bootstrap. Tests set `false`. */
  readonly startRuntime?: boolean;
}

export interface ClickhouseSinkApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: ClickhouseSinkRuntime;
  readonly metrics: SinkMetrics;
}

export async function buildClickhouseSinkApp(options: BuildAppOptions): Promise<ClickhouseSinkApp> {
  const { config } = options;
  const logger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
    ...(config.service.releaseLabel !== undefined
      ? { releaseLabel: config.service.releaseLabel }
      : {}),
  });
  const sinkLogger = logger.child({ component: SINK_SERVICE_NAME });
  const metrics = new SinkMetrics();

  const db = options.db ?? createDb({ postgres: config.postgres });
  const ownsDb = options.db === undefined;

  // The transport advances a checkpoint when the handler resolves; the
  // sink's handler resolves for rows that are still buffered. Deferring
  // the writes until the INSERT is acknowledged is what keeps the
  // position from running ahead of durability.
  const checkpoints = new DeferredCheckpointStore(
    options.checkpoints ??
      (options.consumer !== undefined
        ? new InMemoryCheckpointStore()
        : new PostgresCheckpointStore(db)),
  );

  let connection: TransportConnection | undefined;
  let consumer: PolarisConsumer;
  let poisonProducer: PolarisProducer | undefined;
  if (options.consumer !== undefined) {
    consumer = options.consumer;
  } else {
    connection = createTransportConnection({ rabbitmq: config.rabbitmq, logger: sinkLogger });
    // The sink keeps no metrics registry of its own, so the transport's
    // lifecycle events go to the log only. Before this they went nowhere at
    // all: `hooks` was passed by no service, so a rewind storm and a healthy
    // consumer were indistinguishable from outside the process.
    const hooks = createTransportLogHooks({ logger: sinkLogger, component: SINK_COMPONENT });
    // Only used to DLQ a message that fails repeatedly; the sink has no
    // other reason to publish.
    poisonProducer = createPolarisProducer({
      connection,
      logger: sinkLogger,
      hooks,
      producerName: SINK_SERVICE_NAME,
    });
    await poisonProducer.connect();
    consumer = createPolarisConsumer({
      connection,
      logger: sinkLogger,
      hooks,
      consumerName: SINK_SERVICE_NAME,
      consumerVersion: "v1",
      groupName: config.sink.consumerGroup,
      checkpoints,
      poison: { component: SINK_COMPONENT, producer: poisonProducer },
    });
  }

  const writer =
    options.writer ??
    createAnalyticsSinkWriter({
      url: config.clickhouse.url,
      credential: { username: config.sink.user, password: config.sink.password },
      database: config.clickhouse.database,
      requestTimeoutMs: config.clickhouse.requestTimeoutMs,
      logger: sinkLogger,
    });
  const ownsWriter = options.writer === undefined;

  const runtime = createRuntime({
    consumer,
    writer,
    logger: sinkLogger,
    metrics,
    batchMaxRows: config.sink.batchMaxRows,
    batchMaxMs: config.sink.batchMaxMs,
    checkpoints,
    ...(options.isolatedProjects !== undefined
      ? { isolatedProjects: options.isolatedProjects }
      : {}),
  });

  const shutdownTasks: ShutdownTask[] = [];
  shutdownTasks.push(async () => {
    // Stops consuming, then flushes the open batch — in that order, so
    // shutdown cannot race a delivery into a batch nobody will write.
    try {
      await runtime.stop();
    } catch (err) {
      sinkLogger.error({ err: errSummary(err) }, "runtime stop error during shutdown");
    }
  });
  if (connection !== undefined) {
    const owned = connection;
    const ownedProducer = poisonProducer;
    shutdownTasks.push(async () => {
      try {
        await ownedProducer?.disconnect();
        await owned.close();
      } catch (err) {
        sinkLogger.warn({ err: errSummary(err) }, "transport close error during shutdown");
      }
    });
  }
  if (ownsWriter) {
    shutdownTasks.push(async () => {
      await writer.close();
    });
  }
  if (ownsDb) {
    shutdownTasks.push(async () => {
      await closeDb(db);
    });
  }
  if (options.shutdownTasks !== undefined) {
    shutdownTasks.push(...options.shutdownTasks);
  }

  const bootstrap = await bootstrapService({
    info: {
      serviceName: config.service.serviceName,
      serviceVersion: config.service.serviceVersion,
      environment: config.service.environment,
      ...(config.service.gitSha !== undefined ? { gitSha: config.service.gitSha } : {}),
      ...(config.service.buildTime !== undefined ? { buildTime: config.service.buildTime } : {}),
      ...(config.service.releaseLabel !== undefined
        ? { releaseLabel: config.service.releaseLabel }
        : {}),
    },
    logger: sinkLogger,
    fastify: {
      bodyLimit: config.http.bodyLimitBytes,
      disableRequestLogging: true,
    },
    ...(options.readinessProbes !== undefined ? { readinessProbes: options.readinessProbes } : {}),
    openapi: {
      setup: NOOP_OPENAPI_SETUP,
      metadata: {
        title: "Polaris clickhouse-sink v1",
        version: config.service.serviceVersion,
        description:
          "Consumes resolved.events and the derived families and INSERTs batches into ClickHouse. /health, /ready, and /metrics only — no business routes.",
      },
    },
    ...(shutdownTasks.length > 0 ? { shutdownTasks } : {}),
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
    metrics: {
      producer: () => toPrometheusText(metrics.getSamples()),
    },
  });

  // The runtime drives itself in the background; the HTTP server exists
  // only for health/ready/metrics.
  if (options.startRuntime ?? true) {
    void runtime.start().catch((err: unknown) => {
      sinkLogger.error({ err: errSummary(err) }, "clickhouse sink runtime terminated unexpectedly");
    });
  }

  return { bootstrap, runtime, metrics };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
