/**
 * Service bootstrap for sessionizer v1.
 *
 * Same shape as the analytics-projector and identity-resolver bootstraps:
 *
 *   1. Build the logger and KafkaJS client through `@polaris/shared-transport`.
 *   2. Build the `PolarisProducer` and `PolarisConsumer`.
 *   3. Build the Redis session store (ADR 0005); tests inject their own.
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
import { closeDb, createDb } from "@polaris/shared-db";
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

import type { SessionizerRuntimeConfig } from "./config.js";
import {
  buildRedisOptions,
  createRedisSessionStore,
  type RedisClientLike,
  type RedisSessionStore,
} from "./redis-store.js";
import { createRuntime, type SessionizerRuntime } from "./runtime.js";
import type { SessionStore } from "./store.js";
import {
  DEFAULT_INACTIVITY_SECONDS,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
} from "./transform.js";

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

export interface BuiltSessionizerApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: SessionizerRuntime;
  readonly producer: PolarisProducer;
  readonly consumer: PolarisConsumer;
  readonly store: SessionStore;
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

  // Transport lifecycle -> this processor's log and metrics. Nothing passed
  // `hooks` before, so `consumer.poisoned`, `consumer.rewound` and nine other
  // events were emitted into `undefined` — and `incrementDlq` /
  // `incrementRetry`, which the dashboard plots, had no caller at all.
  const transportHooks = createProcessorTransportHooks({
    logger: processorLogger,
    metrics,
    identity: PROCESSOR_IDENTITY,
  });

  // Session state lives in Redis (ADR 0005) so windows survive a restart
  // and so key expiry carries the inactivity rule. Tests inject an
  // in-memory store through `options.store`; nothing else may, because a
  // silent in-memory fallback would look healthy while quietly losing
  // every session on each deploy — the exact failure this replaced.
  let ownedStore: RedisSessionStore | undefined;
  if (options.store === undefined) {
    ownedStore = createRedisSessionStore({
      client: await createRedisClient(config, processorLogger),
      keyPrefix: config.sessionizer.redisKeyPrefix,
      opTimeoutMs: config.sessionizer.redisOpTimeoutMs,
      logger: processorLogger,
    });
  }
  const store: SessionStore = options.store ?? (ownedStore as RedisSessionStore);

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
        { component: "sessionizer.producer", err: errSummary(err) },
        "session.events producer failed to connect",
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
    store,
    logger: processorLogger,
    metrics,
    ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
    ...(options.isolatedProjects !== undefined
      ? { isolatedProjects: options.isolatedProjects }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    inactivity_seconds: resolveInactivitySeconds(config, processorLogger),
    producer_name: `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`,
    producer_version: config.service.serviceVersion,
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
        { component: "sessionizer.runtime", err: errSummary(err) },
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
  if (ownedStore !== undefined) {
    const owned = ownedStore;
    shutdownTasks.push(async () => {
      await owned.close();
    });
  }
  if (options.shutdownTasks !== undefined) {
    shutdownTasks.push(...options.shutdownTasks);
  }

  // The session store is on the hot path and its failure mode is a stall,
  // not a degradation (see redis-store.ts), so an unhealthy Redis must
  // take the pod out of the ready set rather than let it keep claiming
  // partitions it cannot serve.
  const readinessProbes: ReadinessProbe[] = [...(options.readinessProbes ?? [])];
  if (ownedStore !== undefined) {
    const owned = ownedStore;
    readinessProbes.push(async () => ({
      name: "redis-session-store",
      status: owned.isHealthy() ? "up" : "down",
      ...(owned.isHealthy() ? {} : { detail: "redis session store is not connected" }),
    }));
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
    run,
  };
}

function buildProducer(
  config: SessionizerRuntimeConfig,
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
  config: SessionizerRuntimeConfig,
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
      component: "sessionizer",
      producer,
      // Without this the dead-lettered bytes reach `sessionizer.dlq` and
      // nothing else knows: `polaris processors dlq list` reads a table
      // nobody writes.
      record: recordDlq,
    },
    groupName: config.sessionizer.consumerGroup,
    checkpoints,
  });
  return { consumer, ownsConsumer: true };
}

/**
 * Construct the ioredis client for the session store.
 *
 * Dynamically imported, mirroring `apps/ingester-api/src/app.ts`, so tests
 * that inject a store never pull ioredis in. The error handling is the
 * deliberate opposite of the ingester's: there, a missing ioredis
 * downgrades to dedupe-disabled, because dedupe is an optimisation. Here
 * there is no degraded mode — a sessionizer without a store cannot tell a
 * continuation from a new session, so it must fail to boot rather than
 * start and be wrong.
 */
async function createRedisClient(
  config: SessionizerRuntimeConfig,
  logger: Logger,
): Promise<RedisClientLike> {
  const ioredisModule = (await import("ioredis")) as unknown as {
    readonly default?: new (options: ReturnType<typeof buildRedisOptions>) => RedisClientLike;
  };
  const IoRedisCtor = ioredisModule.default;
  if (typeof IoRedisCtor !== "function") {
    throw new Error(
      "ioredis does not expose a default-exported constructor; the sessionizer cannot start without its session store (ADR 0005).",
    );
  }
  logger.info(
    { component: "sessionizer.store", host: config.redis.host, port: config.redis.port },
    "connecting redis session store",
  );
  return new IoRedisCtor(buildRedisOptions(config.redis));
}

/**
 * Resolve the inactivity window.
 *
 * Always the manifest constant — never the env value.
 *
 * `POLARIS_SESSIONIZER_INACTIVITY_SECONDS` is documented as something an
 * operator may set to MIRROR the manifest for transparency, and the
 * config comment has always claimed the runtime "ignores attempts to
 * widen it". It did not: the configured value was passed straight
 * through, so a deployment could silently run semantics that were not
 * v1's in either direction — a wider window merges sessions that v1
 * would have split, a narrower one splits sessions v1 would have merged.
 *
 * The window is SEMANTIC. Per `docs/architecture/05-processors-and-replay.md`
 * "Processor Configuration", env and PostgreSQL carry runtime
 * configuration and never semantic transformation rules; changing this
 * value is a v2, not a deployment flag. So the env var is now accepted
 * and ignored, and a mismatch is logged at warn — an operator who set it
 * expecting it to take effect deserves to find out from the logs rather
 * than from a session count.
 */
function resolveInactivitySeconds(config: SessionizerRuntimeConfig, logger: Logger): number {
  const configured = config.sessionizer.inactivitySeconds;
  if (configured !== DEFAULT_INACTIVITY_SECONDS) {
    logger.warn(
      {
        component: "sessionizer.config",
        configured_seconds: configured,
        manifest_seconds: DEFAULT_INACTIVITY_SECONDS,
      },
      "POLARIS_SESSIONIZER_INACTIVITY_SECONDS differs from the manifest window and is being ignored; the inactivity window is semantic and changing it requires a new processor version",
    );
  }
  return DEFAULT_INACTIVITY_SECONDS;
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
