/**
 * Service bootstrap for analytics-projector v1.
 *
 * The processor runs as a standalone Node service — same shape as the
 * ingester (`apps/ingester-api/src/app.ts`), but the only HTTP surface is
 * `/health`, `/ready`, and `/metrics`. Business work happens through the
 * KafkaJS consumer wired in `runtime.ts`.
 *
 * Wiring summary:
 *
 *   1. Build the logger and KafkaJS client through `@polaris/shared-kafka`.
 *   2. Build the `PolarisProducer` and `PolarisConsumer`.
 *   3. Build the streaming runtime (the consumer + producer + transform).
 *   4. Hand the runtime's `start`/`stop` and the consumer/producer
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
  type BootstrappedService,
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";

import type { AnalyticsProjectorRuntimeConfig } from "./config.js";
import { type AnalyticsProjectorRuntime, createRuntime } from "./runtime.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION } from "./transform.js";

/**
 * Options accepted by `buildAnalyticsProjectorApp`.
 *
 * Most slots are optional and default to production wiring. Tests
 * override `consumer`, `producer`, and `isolation` to avoid bringing up
 * Redpanda.
 */
export interface BuildAppOptions {
  readonly config: AnalyticsProjectorRuntimeConfig;
  /** Extra readiness probes plugged into `/ready`. */
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  /** Additional shutdown tasks. */
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  /** Whether to install signal handlers. */
  readonly installShutdown?: boolean;
  /** Override of `process.exit` for shutdown tests. */
  readonly shutdownExit?: (code: number) => void;

  // ---- pluggable subsystem overrides ------------------------------------

  /**
   * Pre-built consumer. When supplied, the app does NOT call
   * `connect()` or `disconnect()`; the caller owns the lifecycle. Tests
   * use this slot to inject in-memory fakes.
   */
  readonly consumer?: PolarisConsumer;
  /**
   * Pre-built producer. When supplied, the app does NOT call
   * `connect()` or `disconnect()`; the caller owns the lifecycle.
   */
  readonly producer?: PolarisProducer;
  /**
   * Sync isolation lookup. Defaults to "every project uses the shared
   * topic" — correct for v1 because no project is isolated yet.
   */
  readonly isolation?: SyncIsolationLookup;
  /**
   * Projects currently isolated for `raw.events`. The consumer
   * subscribes to their dedicated topics in addition to the shared one.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Override of `() => new Date()` for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Whether to start the streaming runtime as part of bootstrap.
   * Defaults to `true` for production; tests set this to `false` and
   * drive the runtime's `handler` directly.
   */
  readonly startRuntime?: boolean;
}

/**
 * Outcome of `buildAnalyticsProjectorApp`. Bundles the Fastify bootstrap
 * with the runtime handle so the binary entry point can call
 * `runtime.start()` and `runtime.stop()` deterministically.
 */
export interface BuiltAnalyticsProjectorApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: AnalyticsProjectorRuntime;
  readonly producer: PolarisProducer;
  readonly consumer: PolarisConsumer;
  /**
   * Shared in-process metrics registry the runtime is wired to. Callers
   * (mostly tests and the `/metrics` endpoint extension that lands with
   * P10-002) read counters and gauges from it.
   */
  readonly metrics: ProcessorMetrics;
  /**
   * `true` when the app owns the producer lifecycle (built from config),
   * `false` when a pre-built producer was injected by the caller.
   */
  readonly ownsProducer: boolean;
  /**
   * `true` when the app owns the consumer lifecycle (built from config),
   * `false` when a pre-built consumer was injected by the caller.
   */
  readonly ownsConsumer: boolean;
}

export async function buildAnalyticsProjectorApp(
  options: BuildAppOptions,
): Promise<BuiltAnalyticsProjectorApp> {
  const { config } = options;

  const logger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
    ...(config.service.releaseLabel !== undefined
      ? { releaseLabel: config.service.releaseLabel }
      : {}),
  });

  // The processor-scoped child logger binds the canonical
  // `processor_name` / `processor_version` fields through
  // `@polaris/shared-processor`'s `processorLogContext`. Every Polaris
  // processor uses the same helper, so log pivots across processors stay
  // consistent.
  const processorLogger = logger.child(processorLogContext({ identity: PROCESSOR_IDENTITY }));

  // Shared in-process metrics registry. The runtime increments its
  // counters and gauges; the `/metrics` endpoint exposed by the
  // service-bootstrap can later be extended to expose the registry's
  // samples. The Prometheus migration (P10-002) replaces this class
  // without touching the call sites.
  const metrics = new ProcessorMetrics();

  // ---- consumer + producer --------------------------------------------
  const { producer, ownsProducer } = buildProducer(config, options.producer, processorLogger);
  const { consumer, ownsConsumer } = buildConsumer(config, options.consumer, processorLogger);

  if (ownsProducer) {
    try {
      await producer.connect();
    } catch (err) {
      processorLogger.error(
        { component: "analytics-projector.producer", err: errSummary(err) },
        "analytics.events producer failed to connect",
      );
      // Same posture as the ingester: do not crash. `/ready` will surface
      // the broker outage; runtime will surface per-message publish
      // failures.
    }
  }
  if (ownsConsumer) {
    try {
      await consumer.connect();
    } catch (err) {
      processorLogger.error(
        { component: "analytics-projector.consumer", err: errSummary(err) },
        "raw.events consumer failed to connect",
      );
    }
  }

  // ---- streaming runtime ----------------------------------------------
  const runtime = createRuntime({
    consumer,
    producer,
    logger: processorLogger,
    metrics,
    ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
    ...(options.isolatedProjects !== undefined
      ? { isolatedProjects: options.isolatedProjects }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    partitionsConsumedConcurrently: config.projector.partitionsConsumedConcurrently,
  });

  // ---- shutdown tasks --------------------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  shutdownTasks.push(async () => {
    try {
      await runtime.stop();
    } catch (err) {
      processorLogger.warn(
        { component: "analytics-projector.runtime", err: errSummary(err) },
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
          { component: "analytics-projector.consumer", err: errSummary(err) },
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
          { component: "analytics-projector.producer", err: errSummary(err) },
          "producer disconnect error during shutdown",
        );
      }
    });
  }
  if (options.shutdownTasks !== undefined) {
    shutdownTasks.push(...options.shutdownTasks);
  }

  // ---- Fastify shell (health/ready/metrics, OpenAPI no-op) -----------
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
        title: "Polaris analytics-projector v1",
        version: config.service.serviceVersion,
        description:
          "Streaming processor that reads raw.events and emits analytics.events with processor metadata. No HTTP business routes — /health, /ready, and /metrics only.",
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

  // ---- start runtime ---------------------------------------------------
  if (options.startRuntime ?? true) {
    void runtime.start().catch((err: unknown) => {
      // `runEach` is a long-running promise. If it rejects we record the
      // error and let `/ready` go down through a future probe. Crashing
      // the process here would skip shutdown tasks; instead we log and
      // let orchestrators pull traffic.
      processorLogger.error(
        { component: "analytics-projector.runtime", err: errSummary(err) },
        "streaming runtime terminated unexpectedly",
      );
    });
  }

  return { bootstrap, runtime, producer, consumer, metrics, ownsProducer, ownsConsumer };
}

function buildProducer(
  config: AnalyticsProjectorRuntimeConfig,
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
  config: AnalyticsProjectorRuntimeConfig,
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
      groupId: config.projector.consumerGroup,
    },
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
