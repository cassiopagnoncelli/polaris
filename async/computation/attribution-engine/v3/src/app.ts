/**
 * Service bootstrap for attribution-engine v1.
 *
 * Same shape as the sessionizer / identity-resolver / analytics-projector
 * bootstraps:
 *
 *   1. Build the logger and KafkaJS client through `@polaris/bus`.
 *   2. Build the `PolarisProducer` and `PolarisConsumer`.
 *   3. Build the PostgreSQL touchpoint store (ADR 0005); tests inject their own.
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

import { hostname } from "node:os";
import { closeDb, createDb } from "@polaris/persistence-postgres";
import { createLogger, type Logger } from "@polaris/observability-logger";
import { toPrometheusText } from "@polaris/observability-metrics";
import {
  createDlqLedgerRecorder,
  createKyselyProcessorDlqRecordRepository,
  createLagReporter,
  createProcessorActivationGate,
  createProcessorTransportHooks,
  openProcessorRun,
  type ProcessorActivationGate,
  ProcessorMetrics,
  type ProcessorRunHandle,
  type ProcessorRunRepository,
  processorLogContext,
} from "@polaris/pipeline";
import {
  type BootstrappedService,
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/runtime-service-bootstrap";
import {
  createPolarisConsumer,
  createPolarisProducer,
  createTransportConnection,
  type IsolationSnapshot,
  type PoisonRecord,
  type PolarisConsumer,
  type PolarisProducer,
  PostgresCheckpointStore,
  STREAM_FAMILY_RESOLVED_EVENTS,
  type SyncIsolationLookup,
  startIsolationSnapshot,
  type TransportConnection,
  type TransportHooks,
} from "@polaris/bus";

import type { AttributionEngineRuntimeConfig } from "./config.js";
import { createKyselyTouchpointStore } from "./repository.js";
import { type AttributionEngineRuntime, createRuntime } from "./runtime.js";
import type { TouchpointStore } from "./store.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION } from "./transform.js";

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
  /**
   * This process's run. `run.run_id` is what every derived event carries in
   * `processor.run_id`; `run.registered` says whether a `processor_runs` row
   * exists to join it against.
   */
  readonly run: ProcessorRunHandle;
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

  // Transport lifecycle -> this processor's log and metrics. Nothing passed
  // `hooks` before, so `consumer.poisoned`, `consumer.rewound` and nine other
  // events were emitted into `undefined` — and `incrementDlq` /
  // `incrementRetry`, which the dashboard plots, had no caller at all.
  const transportHooks = createProcessorTransportHooks({
    logger: processorLogger,
    metrics,
    identity: PROCESSOR_IDENTITY,
  });

  // ---- consumer + producer --------------------------------------------
  // One AMQP connection per process, shared by the producer and the
  // consumer. Checkpoints live in PostgreSQL: RabbitMQ streams consumed
  // over AMQP have no server-side offset store, so the resume point is
  // Polaris-owned (see db/postgres/migrations/*_create_transport_checkpoints.sql).
  const connection = createTransportConnection({
    rabbitmq: config.rabbitmq,
    logger: processorLogger,
  });
  const checkpointDb = createDb({ postgres: config.postgres });
  const checkpoints = new PostgresCheckpointStore(checkpointDb);

  // Touchpoint chains live in PostgreSQL (ADR 0005), over the pool the
  // processor already holds for checkpoints — same rationale as the run
  // repository below: durable chain state costs no extra connection.
  // Tests inject the in-memory adapter; nothing else may, because a
  // silent in-memory fallback would look healthy while re-emitting
  // first_touch_assigned for identifiers that already had one.
  const store: TouchpointStore = options.store ?? createKyselyTouchpointStore({ db: checkpointDb });
  const { producer, ownsProducer } = buildProducer(
    config,
    options.producer,
    processorLogger,
    transportHooks,
    connection,
  );
  const { consumer, ownsConsumer } = buildConsumer(
    config,
    options.consumer,
    processorLogger,
    transportHooks,
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
        { component: "attribution-engine.producer", err: errSummary(err) },
        "attribution.events producer failed to connect",
      );
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
  // Owned here rather than by the runtime so the timer stops on shutdown
  // alongside everything else with a lifecycle.
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
  });

  // ---- streaming runtime ----------------------------------------------
  // Topic isolation for the consumer side. Nothing in production ever
  // supplied `isolatedProjects`, so this service subscribed only to the
  // shared family and an isolated project's events sat unread on its
  // dedicated stream. The snapshot reads `topic_isolations` for this
  // environment; the consumer subscribes to the union of shared and
  // dedicated, so an in-flight cutover loses nothing in either direction.
  let isolationSnapshot: IsolationSnapshot | undefined;
  if (options.isolatedProjects === undefined) {
    isolationSnapshot = await startIsolationSnapshot({
      db: checkpointDb,
      environment: config.service.environment,
      logger: logger,
    });
  }

  const runtime = createRuntime({
    consumer,
    producer,
    store,
    logger: processorLogger,
    metrics,
    ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
    isolatedProjects:
      options.isolatedProjects ??
      isolationSnapshot?.isolatedProjects(STREAM_FAMILY_RESOLVED_EVENTS) ??
      [],
    ...(options.now !== undefined ? { now: options.now } : {}),
    run_id: run.run_id,
    gate,
    lag,
  });

  // ---- shutdown tasks --------------------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  if (isolationSnapshot !== undefined) {
    const snapshot = isolationSnapshot;
    shutdownTasks.push(async () => {
      snapshot.stop();
    });
  }
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
  // ---- readiness -------------------------------------------------------
  // `/ready` answered an unconditional 200: no probe was ever registered,
  // here or by `main.ts`, so a pod with a dead transport reported itself
  // ready and kept claiming partitions it could not serve.
  const readinessProbes: ReadinessProbe[] = [...(options.readinessProbes ?? [])];
  if (ownsProducer) {
    readinessProbes.push(async () => {
      const healthy = connection.connected;
      return {
        name: "rabbitmq",
        status: healthy ? ("up" as const) : ("down" as const),
        ...(healthy ? {} : { detail: "transport connection is down" }),
      };
    });
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
    logger: processorLogger,
    fastify: {
      bodyLimit: config.http.bodyLimitBytes,
      disableRequestLogging: true,
    },
    ...(readinessProbes.length > 0 ? { readinessProbes } : {}),
    openapi: {
      setup: NOOP_OPENAPI_SETUP,
      metadata: {
        title: "Polaris attribution-engine v1",
        version: config.service.serviceVersion,
        description:
          "Streaming processor that reads resolved.events and emits attribution.touchpoint_captured / attribution.first_touch_assigned / attribution.last_touch_assigned on attribution.events. No HTTP business routes — /health, /ready, and /metrics only.",
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
    run,
  };
}

function buildProducer(
  config: AttributionEngineRuntimeConfig,
  override: PolarisProducer | undefined,
  logger: Logger,
  hooks: TransportHooks,
  connection: TransportConnection,
): { producer: PolarisProducer; ownsProducer: boolean } {
  if (override !== undefined) {
    return { producer: override, ownsProducer: false };
  }
  const producer = createPolarisProducer({
    connection,
    logger,
    hooks,
    producerName: `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`,
    producerVersion: config.service.serviceVersion,
  });
  return { producer, ownsProducer: true };
}

function buildConsumer(
  config: AttributionEngineRuntimeConfig,
  override: PolarisConsumer | undefined,
  logger: Logger,
  hooks: TransportHooks,
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
    hooks,
    consumerName: PROCESSOR_NAME,
    consumerVersion: PROCESSOR_VERSION,
    poison: {
      component: "attribution-engine",
      producer,
      // Without this the dead-lettered bytes reach `attribution-engine.dlq`
      // and nothing else knows: `polaris processors dlq list` reads a table
      // nobody writes.
      record: recordDlq,
    },
    groupName: config.attributionEngine.consumerGroup,
    checkpoints,
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
