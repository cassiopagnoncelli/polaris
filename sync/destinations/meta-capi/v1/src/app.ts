/**
 * Service bootstrap for meta-capi v1.
 *
 * Mirrors `sync/destinations/webhook-sink/v1/src/app.ts`:
 *
 *   1. Build a structured logger.
 *   2. Build the PostgreSQL `Kysely<Database>` over the shared-config pool.
 *   3. Build the KafkaJS client + `PolarisConsumer` (analytics.events) +
 *      `PolarisProducer` (DLQ publishes only).
 *   4. Build the `DestinationConsumer` runtime from the meta-capi
 *      descriptor and wire it to:
 *        - `createKyselyDestinationInstanceReader` wrapped in
 *          `DestinationInstanceCache` (per-event lookup)
 *        - `createKyselyDeliveryRecordRepository` (delivery_records)
 *        - `createKyselyDlqRecordRepository` (P9-007 triage queue)
 *        - a fresh `DestinationMetrics` registry threaded into `/metrics`
 *   5. Hand the runtime's `start`/`stop` and lifecycle to
 *      `bootstrapService`.
 *
 * Tests inject pre-built consumer + producer + adapters through the
 * `BuildAppOptions` slots so they can drive the runtime without a real
 * RabbitMQ broker or PostgreSQL.
 */

import { closeDb, createDb, type Database, postgresConnectionString } from "@polaris/shared-db";
import {
  createDestinationConsumer,
  createDestinationSharedState,
  createDestinationTransportHooks,
  createKyselyDeliveryRecordRepository,
  createKyselyDestinationInstanceReader,
  createKyselyDlqRecordRepository,
  type DeliveryRecordRepository,
  type DestinationConsumer,
  type DestinationDedupe,
  DestinationInstanceCache,
  type DestinationInstanceReader,
  DestinationMetrics,
  type DestinationRateLimiterLike,
  type DlqRecordRepository,
} from "@polaris/shared-destinations";
import { createLogger, type Logger } from "@polaris/shared-logger";
import { toPrometheusText } from "@polaris/shared-metrics";
import {
  createDestinationProjectConfigLookup,
  createPgListenerTransport,
  createProjectConfigStore,
  type ProjectConfigStore,
} from "@polaris/shared-project-config";
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
  type PolarisConsumer,
  type PolarisProducer,
  PostgresCheckpointStore,
  STREAM_FAMILY_RESOLVED_EVENTS,
  type TransportConnection,
  type TransportHooks,
} from "@polaris/shared-transport";
import type { Kysely } from "kysely";
import type { MetaCapiRuntimeConfig } from "./config.js";
import { createMetaCapiDescriptor } from "./descriptor.js";
import { CONSUMER_VENDOR, CONSUMER_VERSION } from "./descriptor-identity.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";

export interface BuildAppOptions {
  /**
   * Override the dedupe window. Tests inject an in-memory one; production
   * takes whatever `createDestinationSharedState` resolved, which is Redis
   * when it is reachable.
   */
  readonly dedupe?: DestinationDedupe;
  /** Override the rate limiter. Same reasoning as `dedupe`. */
  readonly rateLimiter?: DestinationRateLimiterLike;
  readonly config: MetaCapiRuntimeConfig;
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;

  // ---- pluggable subsystem overrides ------------------------------------

  readonly consumer?: PolarisConsumer;
  readonly producer?: PolarisProducer;
  readonly db?: Kysely<Database>;
  readonly instances?: DestinationInstanceReader;
  readonly records?: DeliveryRecordRepository;
  readonly dlqRecords?: DlqRecordRepository;
  /** Injected in tests; built from the db handle otherwise. */
  readonly projectConfigStore?: ProjectConfigStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly startRuntime?: boolean;
}

export interface BuiltMetaCapiApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: DestinationConsumer;
  readonly producer: PolarisProducer;
  readonly consumer: PolarisConsumer;
  readonly db: Kysely<Database>;
  readonly metrics: DestinationMetrics;
  readonly ownsProducer: boolean;
  readonly ownsConsumer: boolean;
  readonly ownsDb: boolean;
}

export async function buildMetaCapiApp(options: BuildAppOptions): Promise<BuiltMetaCapiApp> {
  const { config } = options;

  const logger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
    ...(config.service.releaseLabel !== undefined
      ? { releaseLabel: config.service.releaseLabel }
      : {}),
  });
  const consumerLogger = logger.child({
    component: "meta-capi.runtime",
    vendor: CONSUMER_VENDOR,
    consumer_version: CONSUMER_VERSION,
  });

  // ---- PostgreSQL ----------------------------------------------------
  const { db, ownsDb } = buildDb(config, options.db);

  // ---- metrics + transport hooks ------------------------------------
  // Built before the transport because the hooks need the registry: until
  // now `TransportHooks` was passed by nobody, so every lifecycle event the
  // consumer emitted — poisoned, rewound, partition_assigned — went into
  // `undefined`.
  const metrics = new DestinationMetrics();
  const transportHooks = createDestinationTransportHooks({
    logger: consumerLogger,
    metrics,
    vendor: CONSUMER_VENDOR,
    consumerVersion: CONSUMER_VERSION,
  });

  // ---- consumer + producer ------------------------------------------
  // One AMQP connection per process, shared by the DLQ producer and the
  // analytics.events consumer. Checkpoints live in PostgreSQL because
  // RabbitMQ streams consumed over AMQP have no server-side offset store.
  const connection = createTransportConnection({
    rabbitmq: config.rabbitmq,
    logger: consumerLogger,
  });
  const checkpoints = new PostgresCheckpointStore(db);
  const { producer, ownsProducer } = buildProducer(
    config,
    options.producer,
    consumerLogger,
    connection,
    transportHooks,
  );
  const { consumer, ownsConsumer } = buildConsumer(
    config,
    options.consumer,
    consumerLogger,
    connection,
    checkpoints,
    producer,
    transportHooks,
  );
  if (ownsProducer) {
    try {
      await producer.connect();
    } catch (err) {
      consumerLogger.error({ err: errSummary(err) }, "destination DLQ producer failed to connect");
    }
  }

  // ---- destination consumer runtime ----------------------------------
  const instances =
    options.instances ??
    new DestinationInstanceCache({
      reader: createKyselyDestinationInstanceReader({ db }),
    });
  const records = options.records ?? createKyselyDeliveryRecordRepository({ db });
  const dlqRecords = options.dlqRecords ?? createKyselyDlqRecordRepository({ db });

  const descriptor = createMetaCapiDescriptor({
    requestTimeoutMs: config.meta.requestTimeoutMs,
    graphHost: config.meta.graphHost,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  // Per-project overrides. Built only when this app owns its db handle; a
  // caller injecting its own pieces gets deployment defaults for every
  // project, which is the pre-cutover behaviour.
  const projectConfigStore =
    options.projectConfigStore ??
    createProjectConfigStore({
      db,
      listener: createPgListenerTransport({
        connectionString: postgresConnectionString(config.postgres),
        logger,
      }),
      logger,
    });
  void projectConfigStore.start().catch((err: unknown) => {
    // Startup must not block on the control plane: until the store is up,
    // every project resolves to the deployment defaults it always used.
    logger.warn(
      { component: "meta-capi.project-config", err },
      "project-config store failed to start; using deployment defaults",
    );
  });

  // Redis-backed dedupe + global RPS. Falls back to the per-process pair
  // when Redis is absent, with a warning — see `createDestinationSharedState`.
  const sharedState = await createDestinationSharedState({
    redis: config.redis,
    logger: consumerLogger,
  });

  const runtime = createDestinationConsumer({
    descriptor,
    dedupe: options.dedupe ?? sharedState.dedupe,
    rateLimiter: options.rateLimiter ?? sharedState.rateLimiter,
    // MVKUP64R: reads the spine's output. The profile and enrichment blocks
    // the identity and enrichment stages wrote are what this vendor's mapper
    // now keys on; see SPEC.md for the per-vendor delta.
    inputFamily: STREAM_FAMILY_RESOLVED_EVENTS,
    consumerBuildVersion:
      config.service.releaseLabel ?? config.service.gitSha ?? config.service.serviceVersion,
    consumer,
    producer,
    instances,
    records,
    dlqRecords,
    logger: consumerLogger,
    allowReplay: config.meta.allowReplay,
    projectConfig: createDestinationProjectConfigLookup({
      store: projectConfigStore,
      namespace: PROJECT_CONFIG_NAMESPACE,
    }),
    metrics,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  // ---- shutdown tasks ------------------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  shutdownTasks.push(async () => {
    try {
      await runtime.stop();
    } catch (err) {
      consumerLogger.warn(
        { err: errSummary(err) },
        "destination runtime stop error during shutdown",
      );
    }
  });
  if (ownsConsumer) {
    shutdownTasks.push(async () => {
      try {
        await consumer.disconnect();
      } catch (err) {
        consumerLogger.warn({ err: errSummary(err) }, "consumer disconnect error during shutdown");
      }
    });
  }
  if (ownsProducer) {
    shutdownTasks.push(async () => {
      try {
        await producer.disconnect();
      } catch (err) {
        consumerLogger.warn({ err: errSummary(err) }, "producer disconnect error during shutdown");
      }
    });
  }
  // Closed before the pool, and separately from it: the store's LISTEN
  // connection is its own `pg` client, not one the Kysely pool hands out, so
  // `closeDb` does not reach it. Leaving it open holds a backend open on the
  // database after a graceful shutdown.
  shutdownTasks.push(async () => {
    try {
      await projectConfigStore.close();
    } catch (err) {
      consumerLogger.warn(
        { err: errSummary(err) },
        "project-config store close error during shutdown",
      );
    }
  });
  if (ownsDb) {
    shutdownTasks.push(async () => {
      try {
        await closeDb(db);
      } catch (err) {
        consumerLogger.warn({ err: errSummary(err) }, "postgres pool close error during shutdown");
      }
    });
  }
  if (options.shutdownTasks !== undefined) {
    shutdownTasks.push(...options.shutdownTasks);
  }

  // ---- Fastify shell -------------------------------------------------
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
    logger: consumerLogger,
    fastify: {
      bodyLimit: config.http.bodyLimitBytes,
      disableRequestLogging: true,
    },
    ...(options.readinessProbes !== undefined ? { readinessProbes: options.readinessProbes } : {}),
    openapi: {
      setup: NOOP_OPENAPI_SETUP,
      metadata: {
        title: "Polaris meta-capi v1",
        version: config.service.serviceVersion,
        description:
          "Destination consumer that POSTs canonical events into Meta's Conversions API. /health, /ready, and /metrics only — no business routes.",
      },
    },
    ...(shutdownTasks.length > 0 ? { shutdownTasks } : {}),
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
    metrics: {
      producer: () => toPrometheusText(metrics.getSamples()),
    },
  });

  // ---- start runtime -------------------------------------------------
  if (options.startRuntime ?? true) {
    void runtime.start().catch((err: unknown) => {
      consumerLogger.error(
        { err: errSummary(err) },
        "destination consumer runtime terminated unexpectedly",
      );
    });
  }

  return {
    bootstrap,
    runtime,
    producer,
    consumer,
    db,
    metrics,
    ownsProducer,
    ownsConsumer,
    ownsDb,
  };
}

/**
 * Build a libpq-style connection string. Mirrors
 * `sync/destinations/webhook-sink/v1/src/app.ts` and
 * `apps/ingester-api/src/app.ts`: user/password URL-encoded; sslmode
 * explicit via URLSearchParams ('require' or 'disable').
 */
function buildDb(
  config: MetaCapiRuntimeConfig,
  override: Kysely<Database> | undefined,
): { db: Kysely<Database>; ownsDb: boolean } {
  if (override !== undefined) {
    return { db: override, ownsDb: false };
  }
  const db = createDb({ postgres: config.postgres });
  return { db, ownsDb: true };
}

function buildProducer(
  config: MetaCapiRuntimeConfig,
  override: PolarisProducer | undefined,
  logger: Logger,
  connection: TransportConnection,
  hooks: TransportHooks,
): { producer: PolarisProducer; ownsProducer: boolean } {
  if (override !== undefined) {
    return { producer: override, ownsProducer: false };
  }
  const producer = createPolarisProducer({
    connection,
    logger,
    hooks,
    producerName: `${CONSUMER_VENDOR}-${CONSUMER_VERSION}`,
    producerVersion: config.service.serviceVersion,
  });
  return { producer, ownsProducer: true };
}

function buildConsumer(
  config: MetaCapiRuntimeConfig,
  override: PolarisConsumer | undefined,
  logger: Logger,
  connection: TransportConnection,
  checkpoints: PostgresCheckpointStore,
  producer: PolarisProducer,
  hooks: TransportHooks,
): { consumer: PolarisConsumer; ownsConsumer: boolean } {
  if (override !== undefined) {
    return { consumer: override, ownsConsumer: false };
  }
  const consumer = createPolarisConsumer({
    connection,
    logger,
    hooks,
    consumerName: CONSUMER_VENDOR,
    consumerVersion: CONSUMER_VERSION,
    poison: { component: "meta-capi", producer },
    groupName: config.meta.consumerGroup,
    checkpoints,
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
