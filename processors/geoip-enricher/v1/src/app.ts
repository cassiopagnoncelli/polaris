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
 *   1. Build the logger and KafkaJS client through `@polaris/shared-transport`.
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
 * RabbitMQ broker.
 */

import { hostname } from "node:os";
import { closeDb, createDb } from "@polaris/shared-db";
import { createLogger, type Logger } from "@polaris/shared-logger";
import { toPrometheusText } from "@polaris/shared-metrics";
import {
  createDlqLedgerRecorder,
  createKyselyProcessorDlqRecordRepository,
  createLagReporter,
  createProcessorActivationGate,
  openProcessorRun,
  type ProcessorActivationGate,
  ProcessorMetrics,
  type ProcessorRunHandle,
  type ProcessorRunRepository,
  processorLogContext,
} from "@polaris/shared-processor";
import {
  type BootstrappedService,
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";
import {
  createPolarisConsumer,
  createPolarisProducer,
  createTransportConnection,
  type PoisonRecord,
  type PolarisConsumer,
  type PolarisProducer,
  PostgresCheckpointStore,
  type SyncIsolationLookup,
  type TransportConnection,
} from "@polaris/shared-transport";

import type { GeoipEnricherRuntimeConfig } from "./config.js";
import type { IPLookup } from "./lookup.js";
import { NoOpIPLookup } from "./lookup.js";
import { createRuntime, type GeoipEnricherRuntime } from "./runtime.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION } from "./transform.js";

/**
 * Options accepted by `buildGeoipEnricherApp`.
 *
 * Most slots are optional and default to production wiring. Tests
 * override `consumer`, `producer`, `lookup`, and `isolation` to avoid
 * bringing up RabbitMQ.
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
  /**
   * Pre-built `processor_runs` repository. Defaults to a Kysely repository
   * over the checkpoint pool — the processor already holds that handle, so
   * recording a run costs no extra connection.
   */
  readonly runRepository?: ProcessorRunRepository;
  /**
   * Whether to record a `processor_runs` row for this process. Defaults to
   * `true`. Tests that build the app without PostgreSQL set `false` so
   * bootstrap does not reach for a database that is not there.
   */
  readonly recordRun?: boolean;
  /**
   * Activation gate override. Defaults to a PostgreSQL-backed gate over the
   * checkpoint pool, so `polaris processors disable` stops this processor for
   * the scopes it names. Tests inject `ALWAYS_ENABLED_GATE` or a stub.
   */
  readonly gate?: ProcessorActivationGate;
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
  /**
   * This process's run. `run.run_id` is what every derived event carries in
   * `processor.run_id`; `run.registered` says whether a `processor_runs` row
   * exists to join it against.
   */
  readonly run: ProcessorRunHandle;
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
    producer,
    createDlqLedgerRecorder({
      repository: createKyselyProcessorDlqRecordRepository({ db: checkpointDb }),
      identity: PROCESSOR_IDENTITY,
    }),
  );

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

  // ---- activation gate -------------------------------------------------
  // Per-message, over the pool the processor already holds. `disabled` rows
  // are the only thing that closes it; see the gate's module header for why
  // absence means allowed.
  const gate =
    options.gate ??
    createProcessorActivationGate({
      identity: PROCESSOR_IDENTITY,
      db: checkpointDb,
      logger: processorLogger,
    });

  // ---- lag reporting ---------------------------------------------------
  // Owned here rather than by the runtime so the timer is stopped on
  // shutdown alongside everything else with a lifecycle.
  const lag = createLagReporter({ metrics, identity: PROCESSOR_IDENTITY });

  // ---- processor run ---------------------------------------------------
  // Registered BEFORE the runtime is built: the runtime stamps
  // `processor.run_id` onto every derived event, and the id has to exist by
  // the time the first message lands. `openProcessorRun` never throws — a
  // control-plane outage costs the run row, not the data path.
  const run = await openProcessorRun({
    enabled: options.recordRun ?? true,
    ...(options.runRepository !== undefined ? { repository: options.runRepository } : {}),
    db: checkpointDb,
    identity: PROCESSOR_IDENTITY,
    // No `project_id`: the processor reads every project's events off the
    // shared stream, so the run is cross-project by construction.
    environment: config.service.environment,
    host: hostname(),
    logger: processorLogger,
    metrics,
    // Explicit id from the caller (replay tooling, tests): the ROW takes it
    // too, so the stamped id and the recorded run never disagree.
    ...(options.run_id !== undefined ? { run_id: options.run_id } : {}),
  });

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
    run_id: run.run_id,
    gate,
    lag,
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
  // Straight after the runtime stops and well before `closeDb` at the end of
  // the list: the run row is written through the checkpoint pool, so it has to
  // close out while that pool is still open. Counters are read from the metrics
  // registry once the runtime is quiet. A no-op when nothing was registered.
  shutdownTasks.push(async () => {
    lag.stop();
    await run.complete();
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
    run,
  };
}

function buildProducer(
  config: GeoipEnricherRuntimeConfig,
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
  config: GeoipEnricherRuntimeConfig,
  override: PolarisConsumer | undefined,
  logger: Logger,
  connection: TransportConnection,
  checkpoints: PostgresCheckpointStore,
  producer: PolarisProducer,
  /** Ledger write for a dead-lettered message; see the poison handle below. */
  recordDlq: (record: PoisonRecord) => Promise<void>,
): { consumer: PolarisConsumer; ownsConsumer: boolean } {
  if (override !== undefined) {
    return { consumer: override, ownsConsumer: false };
  }
  const consumer = createPolarisConsumer({
    connection,
    logger,
    consumerName: PROCESSOR_NAME,
    consumerVersion: PROCESSOR_VERSION,
    poison: {
      component: "geoip-enricher",
      producer,
      // Without this the dead-lettered bytes reach `geoip-enricher.dlq` and
      // nothing else knows: `polaris processors dlq list` reads a table
      // nobody writes.
      record: recordDlq,
    },
    groupName: config.enricher.consumerGroup,
    checkpoints,
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
