/**
 * Service bootstrap for geoip-enricher v1.
 *
 * The processor runs as a standalone Node service — same shape as the
 * ingester (`apps/ingester-api/src/app.ts`) and the analytics-projector,
 * but the only HTTP surface is `/health`, `/ready`, and `/metrics`.
 * Business work happens through the KafkaJS consumer wired in
 * `runtime.ts`.
 *
 * Wiring summary:
 *
 *   1. Build the logger and KafkaJS client through `@polaris/shared-kafka`.
 *   2. Build the `PolarisProducer` and `PolarisConsumer`.
 *   3. Build the streaming runtime (the consumer + producer + transform
 *      + `IPLookup` adapter).
 *   4. Hand the runtime's `start`/`stop` and the consumer/producer
 *      lifecycles to `bootstrapService`:
 *        - `/ready` reports producer + consumer connection state.
 *        - shutdown tasks disconnect producer and consumer in order.
 *
 * Tests inject a pre-built consumer + producer + lookup through the
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

import type { GeoipEnricherRuntimeConfig } from "./config.js";
import type { IPLookup } from "./lookup.js";
import { NoOpIPLookup } from "./lookup.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION } from "./transform.js";
import { createRuntime, type GeoipEnricherRuntime } from "./runtime.js";

/**
 * Options accepted by `buildGeoipEnricherApp`.
 *
 * Most slots are optional and default to production wiring. Tests
 * override `consumer`, `producer`, `lookup`, and `isolation` to avoid
 * bringing up Redpanda.
 */
export interface BuildAppOptions {
  readonly config: GeoipEnricherRuntimeConfig;
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
   * `connect()` or `disconnect()`; the caller owns the lifecycle.
   * Tests use this slot to inject in-memory fakes.
   */
  readonly consumer?: PolarisConsumer;
  /**
   * Pre-built producer. When supplied, the app does NOT call
   * `connect()` or `disconnect()`; the caller owns the lifecycle.
   */
  readonly producer?: PolarisProducer;
  /**
   * IP-to-geo backend. Defaults to `NoOpIPLookup` so a misconfigured
   * deployment fails open. Tests inject `InMemoryIPLookup`.
   */
  readonly lookup?: IPLookup;
  /**
   * Sync isolation lookup. Defaults to "every project uses the shared
   * topic" — correct for v1 because no project is isolated yet.
   */
  readonly isolation?: SyncIsolationLookup;
  /**
   * Projects currently isolated for `raw.events`. The consumer
   * subscribes to their dedicated topics in addition to the shared
   * one.
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
  /** Per-run identifier (UUIDv7) stamped on every emitted event. */
  readonly run_id?: string;
}

/**
 * Outcome of `buildGeoipEnricherApp`. Bundles the Fastify bootstrap
 * with the runtime handle so the binary entry point can call
 * `runtime.start()` and `runtime.stop()` deterministically.
 */
export interface BuiltGeoipEnricherApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: GeoipEnricherRuntime;
  readonly producer: PolarisProducer;
  readonly consumer: PolarisConsumer;
  /**
   * Shared in-process metrics registry the runtime is wired to.
   * Callers (tests, `/metrics` endpoint extension) read counters and
   * gauges from it.
   */
  readonly metrics: ProcessorMetrics;
  /** Lookup adapter the runtime is wired to. */
  readonly lookup: IPLookup;
  /** `true` when the app owns the producer lifecycle. */
  readonly ownsProducer: boolean;
  /** `true` when the app owns the consumer lifecycle. */
  readonly ownsConsumer: boolean;
}

export async function buildGeoipEnricherApp(
  options: BuildAppOptions,
): Promise<BuiltGeoipEnricherApp> {
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
  // processor uses the same helper, so log pivots across processors
  // stay consistent.
  const processorLogger = logger.child(processorLogContext({ identity: PROCESSOR_IDENTITY }));

  // Shared in-process metrics registry. The runtime increments its
  // counters and gauges; the `/metrics` endpoint exposed by the
  // service-bootstrap can later be extended to expose the registry's
  // samples. The Prometheus migration (P10-002) replaces this class
  // without touching the call sites.
  const metrics = new ProcessorMetrics();

  const lookup = options.lookup ?? new NoOpIPLookup();

  // ---- consumer + producer --------------------------------------------
  const { producer, ownsProducer } = buildProducer(config, options.producer, processorLogger);
  const { consumer, ownsConsumer } = buildConsumer(config, options.consumer, processorLogger);

  if (ownsProducer) {
    try {
      await producer.connect();
    } catch (err) {
      processorLogger.error(
        { component: "geoip-enricher.producer", err: errSummary(err) },
        "enriched.events producer failed to connect",
      );
      // Same posture as the ingester and analytics-projector: do not
      // crash. `/ready` surfaces the broker outage; the runtime
      // surfaces per-message publish failures.
    }
  }
  if (ownsConsumer) {
    try {
      await consumer.connect();
    } catch (err) {
      processorLogger.error(
        { component: "geoip-enricher.consumer", err: errSummary(err) },
        "raw.events consumer failed to connect",
      );
    }
  }

  // ---- streaming runtime ----------------------------------------------
  const runtime = createRuntime({
    consumer,
    producer,
    logger: processorLogger,
    lookup,
    metrics,
    ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
    ...(options.isolatedProjects !== undefined
      ? { isolatedProjects: options.isolatedProjects }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.run_id !== undefined ? { run_id: options.run_id } : {}),
    partitionsConsumedConcurrently: config.enricher.partitionsConsumedConcurrently,
  });

  // ---- shutdown tasks --------------------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  shutdownTasks.push(async () => {
    try {
      await runtime.stop();
    } catch (err) {
      processorLogger.warn(
        { component: "geoip-enricher.runtime", err: errSummary(err) },
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
          { component: "geoip-enricher.consumer", err: errSummary(err) },
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
          { component: "geoip-enricher.producer", err: errSummary(err) },
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
        title: "Polaris geoip-enricher v1",
        version: config.service.serviceVersion,
        description:
          "Streaming processor that reads raw.events, looks up context.ip against a swappable IPLookup backend, and emits enriched.geoip events on enriched.events keyed back to the source event_id. No HTTP business routes — /health, /ready, and /metrics only.",
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
      // `runEach` is a long-running promise. If it rejects we record
      // the error and let `/ready` go down through a future probe.
      // Crashing the process here would skip shutdown tasks; instead
      // we log and let orchestrators pull traffic.
      processorLogger.error(
        { component: "geoip-enricher.runtime", err: errSummary(err) },
        "streaming runtime terminated unexpectedly",
      );
    });
  }

  return {
    bootstrap,
    runtime,
    producer,
    consumer,
    metrics,
    lookup,
    ownsProducer,
    ownsConsumer,
  };
}

function buildProducer(
  config: GeoipEnricherRuntimeConfig,
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
  config: GeoipEnricherRuntimeConfig,
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
      groupId: config.enricher.consumerGroup,
    },
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
