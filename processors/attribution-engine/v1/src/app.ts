/**
 * Service bootstrap for attribution-engine v1.
 *
 * Same shape as the sessionizer / identity-resolver / analytics-projector
 * bootstraps:
 *
 *   1. Build the logger and KafkaJS client through `@polaris/shared-kafka`.
 *   2. Build the `PolarisProducer` and `PolarisConsumer`.
 *   3. Build the in-memory touchpoint store (v1 has no Redis variant).
 *   4. Build the streaming runtime (consumer + producer + store + transform).
 *   5. Hand the runtime's `start`/`stop` and the consumer/producer
 *      lifecycles to `bootstrapService`:
 *        - `/ready` reports producer + consumer connection state.
 *        - shutdown tasks disconnect producer and consumer in order.
 *
 * Tests inject a pre-built consumer + producer through the
 * `BuildAppOptions` slots so they can drive the runtime without a real
 * Redpanda broker.
 */

import {
  createKafkaClient,
  createPolarisConsumer,
  createPolarisProducer,
  type PolarisConsumer,
  type PolarisProducer,
  type SyncIsolationLookup,
} from "@polaris/shared-kafka";
import { createLogger, type Logger } from "@polaris/shared-logger";
import { toPrometheusText } from "@polaris/shared-metrics";
import { ProcessorMetrics, processorLogContext } from "@polaris/shared-processor";
import {
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type BootstrappedService,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";

import type { AttributionEngineRuntimeConfig } from "./config.js";
import { InMemoryTouchpointStore, type TouchpointStore } from "./store.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION } from "./transform.js";
import { createRuntime, type AttributionEngineRuntime } from "./runtime.js";

export interface BuildAppOptions {
  readonly config: AttributionEngineRuntimeConfig;
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
  readonly store?: TouchpointStore;
  /** Whether to start the streaming runtime as part of bootstrap. */
  readonly startRuntime?: boolean;
}

export interface BuiltAttributionEngineApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: AttributionEngineRuntime;
  readonly producer: PolarisProducer;
  readonly consumer: PolarisConsumer;
  readonly store: TouchpointStore;
  readonly metrics: ProcessorMetrics;
  readonly ownsProducer: boolean;
  readonly ownsConsumer: boolean;
}

export async function buildAttributionEngineApp(
  options: BuildAppOptions,
): Promise<BuiltAttributionEngineApp> {
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
  const store = options.store ?? new InMemoryTouchpointStore();

  // ---- consumer + producer --------------------------------------------
  const { producer, ownsProducer } = buildProducer(config, options.producer, processorLogger);
  const { consumer, ownsConsumer } = buildConsumer(config, options.consumer, processorLogger);

  if (ownsProducer) {
    try {
      await producer.connect();
    } catch (err) {
      processorLogger.error(
        { component: "attribution-engine.producer", err: errSummary(err) },
        "attribution.events producer failed to connect",
      );
    }
  }
  if (ownsConsumer) {
    try {
      await consumer.connect();
    } catch (err) {
      processorLogger.error(
        { component: "attribution-engine.consumer", err: errSummary(err) },
        "analytics.events consumer failed to connect",
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
    partitionsConsumedConcurrently: config.attributionEngine.partitionsConsumedConcurrently,
  });

  // ---- shutdown tasks --------------------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  shutdownTasks.push(async () => {
    try {
      await runtime.stop();
    } catch (err) {
      processorLogger.warn(
        { component: "attribution-engine.runtime", err: errSummary(err) },
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
          { component: "attribution-engine.consumer", err: errSummary(err) },
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
          { component: "attribution-engine.producer", err: errSummary(err) },
          "producer disconnect error during shutdown",
        );
      }
    });
  }
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
        title: "Polaris attribution-engine v1",
        version: config.service.serviceVersion,
        description:
          "Streaming processor that reads analytics.events and emits attribution.touchpoint_captured / attribution.first_touch_assigned / attribution.last_touch_assigned on attribution.events. No HTTP business routes — /health, /ready, and /metrics only.",
      },
    },
    ...(shutdownTasks.length > 0 ? { shutdownTasks } : {}),
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
    // Wire /metrics to the live ProcessorMetrics registry.
    metrics: {
      producer: () => toPrometheusText(metrics.getSamples()),
    },
  });

  if (options.startRuntime ?? true) {
    void runtime.start().catch((err: unknown) => {
      processorLogger.error(
        { component: "attribution-engine.runtime", err: errSummary(err) },
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
  config: AttributionEngineRuntimeConfig,
  override: PolarisProducer | undefined,
  logger: Logger,
): { producer: PolarisProducer; ownsProducer: boolean } {
  if (override !== undefined) {
    return { producer: override, ownsProducer: false };
  }
  const kafka = createKafkaClient({ redpanda: config.redpanda });
  const producer = createPolarisProducer({
    kafka,
    logger,
    producerName: `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`,
    producerVersion: config.service.serviceVersion,
  });
  return { producer, ownsProducer: true };
}

function buildConsumer(
  config: AttributionEngineRuntimeConfig,
  override: PolarisConsumer | undefined,
  logger: Logger,
): { consumer: PolarisConsumer; ownsConsumer: boolean } {
  if (override !== undefined) {
    return { consumer: override, ownsConsumer: false };
  }
  const kafka = createKafkaClient({ redpanda: config.redpanda });
  const consumer = createPolarisConsumer({
    kafka,
    logger,
    consumerName: PROCESSOR_NAME,
    consumerVersion: PROCESSOR_VERSION,
    consumerConfig: {
      groupId: config.attributionEngine.consumerGroup,
    },
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
