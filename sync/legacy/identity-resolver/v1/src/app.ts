/**
 * Service bootstrap for identity-resolver v1.
 *
 * Mirrors `async/computation/sessionizer/v1/src/app.ts` with the addition of
 * a PostgreSQL Kysely client backing the `identity_links` repository:
 *
 *   1. Build the logger + processor-scoped child.
 *   2. Build the PostgreSQL Kysely client + `KyselyIdentityLinkRepository`.
 *   3. Build the KafkaJS client + `PolarisConsumer` (`raw.events`) +
 *      `PolarisProducer` (`identity.events`).
 *   4. Build the streaming runtime with consumer + producer + repository.
 *   5. Hand shutdown tasks to `bootstrapService`: stop runtime, disconnect
 *      consumer/producer, end PostgreSQL pool.
 *
 * Tests inject pre-built consumer / producer / repository through the
 * `BuildAppOptions` slots so they can drive the runtime without a real
 * RabbitMQ or PostgreSQL.
 */

import { hostname } from "node:os";

import { closeDb, createDb, type Database } from "@polaris/shared-db";
import { createLogger, type Logger } from "@polaris/shared-logger";
import { toPrometheusText } from "@polaris/shared-metrics";
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
  type TransportHooks,
} from "@polaris/shared-transport";
import type { Kysely } from "kysely";

import type { IdentityResolverRuntimeConfig } from "./config.js";
import { createKyselyIdentityLinkRepository, type IdentityLinkRepository } from "./repository.js";
import { createRuntime, type IdentityResolverRuntime } from "./runtime.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION } from "./transform.js";

export interface BuildAppOptions {
  readonly config: IdentityResolverRuntimeConfig;
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;

  // ---- pluggable subsystem overrides ------------------------------------

  readonly consumer?: PolarisConsumer;
  readonly producer?: PolarisProducer;
  readonly db?: Kysely<Database>;
  readonly repository?: IdentityLinkRepository;
  readonly isolation?: SyncIsolationLookup;
  readonly isolatedProjects?: ReadonlyArray<string>;
  readonly now?: () => Date;
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

export interface BuiltIdentityResolverApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: IdentityResolverRuntime;
  readonly producer: PolarisProducer;
  readonly consumer: PolarisConsumer;
  readonly db: Kysely<Database>;
  readonly repository: IdentityLinkRepository;
  readonly metrics: ProcessorMetrics;
  readonly ownsProducer: boolean;
  readonly ownsConsumer: boolean;
  readonly ownsDb: boolean;
  /**
   * This process's run. `run.run_id` is what every derived event carries in
   * `processor.run_id`; `run.registered` says whether a `processor_runs` row
   * exists to join it against.
   */
  readonly run: ProcessorRunHandle;
}

export async function buildIdentityResolverApp(
  options: BuildAppOptions,
): Promise<BuiltIdentityResolverApp> {
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

  // ---- PostgreSQL + repository ----------------------------------------
  const { db, ownsDb } = buildDb(config, options.db);
  const repository = options.repository ?? createKyselyIdentityLinkRepository({ db });

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
        { component: "identity-resolver.producer", err: errSummary(err) },
        "identity.events producer failed to connect",
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
  });

  // ---- streaming runtime ----------------------------------------------
  const runtime = createRuntime({
    consumer,
    producer,
    repository,
    logger: processorLogger,
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
        { component: "identity-resolver.runtime", err: errSummary(err) },
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
          { component: "identity-resolver.consumer", err: errSummary(err) },
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
          { component: "identity-resolver.producer", err: errSummary(err) },
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
  if (ownsDb) {
    shutdownTasks.push(async () => {
      try {
        await closeDb(db);
      } catch (err) {
        processorLogger.warn(
          { component: "identity-resolver.db", err: errSummary(err) },
          "postgres pool close error during shutdown",
        );
      }
    });
  }
  if (options.shutdownTasks !== undefined) {
    shutdownTasks.push(...options.shutdownTasks);
  }

  // ---- readiness -------------------------------------------------------
  // `/ready` answered an unconditional 200 for this service: no probe was
  // ever registered, here or by `main.ts`. A pod with a dead producer or an
  // unreachable checkpoint store therefore reported itself ready and kept
  // claiming partitions it could not serve.
  //
  // Both dependencies are load-bearing. Without the producer nothing reaches
  // identity.events; without the checkpoint pool a handled message cannot record
  // its position, which now pauses the reader by design.
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
    ...(readinessProbes.length > 0 ? { readinessProbes } : {}),
    openapi: {
      setup: NOOP_OPENAPI_SETUP,
      metadata: {
        title: "Polaris identity-resolver v1",
        version: config.service.serviceVersion,
        description:
          "Streaming processor that reads raw.events, detects authoritative identity overlaps, persists links to identity_links, and emits canonical identity.linked / merged / rotated on identity.events. /health, /ready, /metrics only.",
      },
    },
    ...(shutdownTasks.length > 0 ? { shutdownTasks } : {}),
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
    metrics: {
      producer: () => toPrometheusText(metrics.getSamples()),
    },
  });

  if (options.startRuntime ?? true) {
    void runtime.start().catch((err: unknown) => {
      processorLogger.error(
        { component: "identity-resolver.runtime", err: errSummary(err) },
        "streaming runtime terminated unexpectedly",
      );
    });
  }

  return {
    bootstrap,
    runtime,
    producer,
    consumer,
    db,
    repository,
    metrics,
    ownsProducer,
    ownsConsumer,
    ownsDb,
    run,
  };
}

function buildDb(
  config: IdentityResolverRuntimeConfig,
  override: Kysely<Database> | undefined,
): { db: Kysely<Database>; ownsDb: boolean } {
  if (override !== undefined) {
    return { db: override, ownsDb: false };
  }
  const db = createDb({ postgres: config.postgres });
  return { db, ownsDb: true };
}

function buildProducer(
  config: IdentityResolverRuntimeConfig,
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
  config: IdentityResolverRuntimeConfig,
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
      component: "identity-resolver",
      producer,
      // Without this the dead-lettered bytes reach `identity-resolver.dlq` and
      // nothing else knows: `polaris processors dlq list` reads a table
      // nobody writes.
      record: recordDlq,
    },
    groupName: config.resolver.consumerGroup,
    checkpoints,
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
