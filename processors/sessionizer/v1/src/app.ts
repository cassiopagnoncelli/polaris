/**
 * Service bootstrap for sessionizer v1.
 *
 * Same shape as the analytics-projector and identity-resolver bootstraps:
 *
 *   1. Build the logger and KafkaJS client through `@polaris/shared-transport`.
 *   2. Build the `PolarisProducer` and `PolarisConsumer`.
 *   3. Build the in-memory session store (v1 has no Redis variant).
 *   4. Build the streaming runtime (consumer + producer + store + transform).
 *   5. Hand the runtime's `start`/`stop` and the consumer/producer
 *      lifecycles to `bootstrapService`:
 *        - `/ready` reports producer + consumer connection state.
 *        - shutdown tasks disconnect producer and consumer in order.
 *
 * Tests inject a pre-built consumer + producer through the
 * `BuildAppOptions` slots so they can drive the runtime without a real
 * RabbitMQ broker.
 */

import {
  createTransportConnection,
  type TransportConnection,
  createPolarisConsumer,
  PostgresCheckpointStore,
  createPolarisProducer,
  type PolarisConsumer,
  type PolarisProducer,
  type SyncIsolationLookup,
} from "@polaris/shared-transport";
import { closeDb, createDb } from "@polaris/shared-db";
import { createLogger, type Logger } from "@polaris/shared-logger";
import { toPrometheusText } from "@polaris/shared-metrics";
import { ProcessorMetrics, processorLogContext } from "@polaris/shared-processor";
import {
  type BootstrappedService,
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";

import type { SessionizerRuntimeConfig } from "./config.js";
import { createRuntime, type SessionizerRuntime } from "./runtime.js";
import { InMemorySessionStore, type SessionStore } from "./store.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION } from "./transform.js";

export interface BuildAppOptions {
  readonly config: SessionizerRuntimeConfig;
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;

  // ---- pluggable subsystem overrides ------------------------------------

  readonly consumer?: PolarisConsumer;
  readonly producer?: PolarisProducer;
  readonly isolation?: SyncIsolationLookup;
  readonly isolatedProjects?: ReadonlyArray<string>;
  readonly now?: () => Date;
  readonly store?: SessionStore;
  /** Whether to start the streaming runtime as part of bootstrap. */
  readonly startRuntime?: boolean;
}

export interface BuiltSessionizerApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: SessionizerRuntime;
  readonly producer: PolarisProducer;
  readonly consumer: PolarisConsumer;
  readonly store: SessionStore;
  readonly metrics: ProcessorMetrics;
  readonly ownsProducer: boolean;
  readonly ownsConsumer: boolean;
}

export async function buildSessionizerApp(options: BuildAppOptions): Promise<BuiltSessionizerApp> {
  const { config } = options;

  const logger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
    ...(config.service.releaseLabel !== undefined
      ? { releaseLabel: config.service.releaseLabel }
      : {}),
  });
  const processorLogger = logger.child(processorLogContext({ identity: PROCESSOR_IDENTITY }));

  const metrics = new ProcessorMetrics();
  const store = options.store ?? new InMemorySessionStore();

  // ---- consumer + producer --------------------------------------------
  // One AMQP connection per process, shared by the producer and the
  // consumer. Checkpoints live in PostgreSQL: RabbitMQ streams consumed
  // over AMQP have no server-side offset store, so the resume point is
  // Polaris-owned (see db/migrations/*_create_transport_checkpoints.sql).
  const connection = createTransportConnection({
    rabbitmq: config.rabbitmq,
    logger: processorLogger,
  });
  const checkpointDb = createDb({ postgres: config.postgres });
  const checkpoints = new PostgresCheckpointStore(checkpointDb);
  const { producer, ownsProducer } = buildProducer(
    config,
    options.producer,
    processorLogger,
    connection,
  );
  const { consumer, ownsConsumer } = buildConsumer(
    config,
    options.consumer,
    processorLogger,
    connection,
    checkpoints,
  );

  if (ownsProducer) {
    try {
      await producer.connect();
    } catch (err) {
      processorLogger.error(
        { component: "sessionizer.producer", err: errSummary(err) },
        "session.events producer failed to connect",
      );
    }
  }

  // ---- streaming runtime ----------------------------------------------
  const runtime = createRuntime({
    consumer,
    producer,
    store,
    logger: processorLogger,
    metrics,
    ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
    ...(options.isolatedProjects !== undefined
      ? { isolatedProjects: options.isolatedProjects }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    inactivity_seconds: config.sessionizer.inactivitySeconds,
    producer_name: `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`,
    producer_version: config.service.serviceVersion,
  });

  // ---- shutdown tasks --------------------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  shutdownTasks.push(async () => {
    try {
      await runtime.stop();
    } catch (err) {
      processorLogger.warn(
        { component: "sessionizer.runtime", err: errSummary(err) },
        "runtime stop error during shutdown",
      );
    }
  });
  if (ownsConsumer) {
    shutdownTasks.push(async () => {
      try {
        await consumer.disconnect();
      } catch (err) {
        processorLogger.warn(
          { component: "sessionizer.consumer", err: errSummary(err) },
          "consumer disconnect error during shutdown",
        );
      }
    });
  }
  if (ownsProducer) {
    shutdownTasks.push(async () => {
      try {
        await producer.disconnect();
      } catch (err) {
        processorLogger.warn(
          { component: "sessionizer.producer", err: errSummary(err) },
          "producer disconnect error during shutdown",
        );
      }
    });
  }
  shutdownTasks.push(async () => {
    // checkpoint transport shutdown: the consumer has already flushed its
    // offsets, so the connection and the checkpoint pool go last.
    try {
      await connection.close();
    } catch (err) {
      processorLogger.warn(
        { component: "transport", err: errSummary(err) },
        "transport connection close error during shutdown",
      );
    }
    await closeDb(checkpointDb);
  });
  if (options.shutdownTasks !== undefined) {
    shutdownTasks.push(...options.shutdownTasks);
  }

  // ---- Fastify shell ---------------------------------------------------
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
    logger: processorLogger,
    fastify: {
      bodyLimit: config.http.bodyLimitBytes,
      disableRequestLogging: true,
    },
    ...(options.readinessProbes !== undefined ? { readinessProbes: options.readinessProbes } : {}),
    openapi: {
      setup: NOOP_OPENAPI_SETUP,
      metadata: {
        title: "Polaris sessionizer v1",
        version: config.service.serviceVersion,
        description:
          "Streaming processor that reads raw.events and emits session.started / session.ended on session.events. No HTTP business routes — /health, /ready, and /metrics only.",
      },
    },
    ...(shutdownTasks.length > 0 ? { shutdownTasks } : {}),
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
    // Wire /metrics to the live ProcessorMetrics registry (P10-002).
    metrics: {
      producer: () => toPrometheusText(metrics.getSamples()),
    },
  });

  if (options.startRuntime ?? true) {
    void runtime.start().catch((err: unknown) => {
      processorLogger.error(
        { component: "sessionizer.runtime", err: errSummary(err) },
        "streaming runtime terminated unexpectedly",
      );
    });
  }

  return {
    bootstrap,
    runtime,
    producer,
    consumer,
    store,
    metrics,
    ownsProducer,
    ownsConsumer,
  };
}

function buildProducer(
  config: SessionizerRuntimeConfig,
  override: PolarisProducer | undefined,
  logger: Logger,
  connection: TransportConnection,
): { producer: PolarisProducer; ownsProducer: boolean } {
  if (override !== undefined) {
    return { producer: override, ownsProducer: false };
  }
  const producer = createPolarisProducer({
    connection,
    logger,
    producerName: `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`,
    producerVersion: config.service.serviceVersion,
  });
  return { producer, ownsProducer: true };
}

function buildConsumer(
  config: SessionizerRuntimeConfig,
  override: PolarisConsumer | undefined,
  logger: Logger,
  connection: TransportConnection,
  checkpoints: PostgresCheckpointStore,
): { consumer: PolarisConsumer; ownsConsumer: boolean } {
  if (override !== undefined) {
    return { consumer: override, ownsConsumer: false };
  }
  const consumer = createPolarisConsumer({
    connection,
    logger,
    consumerName: PROCESSOR_NAME,
    consumerVersion: PROCESSOR_VERSION,
    groupName: config.sessionizer.consumerGroup,
    checkpoints,
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
