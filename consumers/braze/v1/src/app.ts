/**
 * Service bootstrap for braze v1.
 *
 * Mirrors `consumers/tiktok/v1/src/app.ts`:
 *
 *   1. Build a structured logger.
 *   2. Build the PostgreSQL `Kysely<Database>` over the shared-config pool.
 *   3. Build the KafkaJS client + `PolarisConsumer` (analytics.events) +
 *      `PolarisProducer` (DLQ publishes only).
 *   4. Build the `DestinationConsumer` runtime from the braze
 *      descriptor and wire it to:
 *        - `createKyselyDestinationInstanceReader` wrapped in
 *          `DestinationInstanceCache` (per-event lookup)
 *        - `createKyselyDeliveryRecordRepository` (delivery_records)
 *        - `createKyselyDlqRecordRepository` (P9-007 triage queue)
 *        - `SecretResolver` with the env-backed adapter
 *        - a fresh `DestinationMetrics` registry threaded into `/metrics`
 *   5. Hand the runtime's `start`/`stop` and lifecycle to
 *      `bootstrapService`.
 *
 * Tests inject pre-built consumer + producer + adapters through the
 * `BuildAppOptions` slots so they can drive the runtime without a real
 * RabbitMQ broker or PostgreSQL.
 */

import { closeDb, createDb, type Database } from "@polaris/shared-db";
import {
  createDestinationConsumer,
  createKyselyDeliveryRecordRepository,
  createKyselyDestinationInstanceReader,
  createKyselyDlqRecordRepository,
  type DeliveryRecordRepository,
  type DestinationConsumer,
  DestinationInstanceCache,
  type DestinationInstanceReader,
  DestinationMetrics,
  type DlqRecordRepository,
} from "@polaris/shared-destinations";
import {
  createTransportConnection,
  type TransportConnection,
  createPolarisConsumer,
  PostgresCheckpointStore,
  createPolarisProducer,
  type PolarisConsumer,
  type PolarisProducer,
} from "@polaris/shared-transport";
import { createLogger, type Logger } from "@polaris/shared-logger";
import { toPrometheusText } from "@polaris/shared-metrics";
import { EnvSecretProvider, SecretResolver } from "@polaris/shared-secrets";
import {
  type BootstrappedService,
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";
import type { Kysely } from "kysely";

import type { BrazeRuntimeConfig } from "./config.js";
import { createBrazeDescriptor } from "./descriptor.js";
import { CONSUMER_VENDOR, CONSUMER_VERSION } from "./descriptor-identity.js";

export interface BuildAppOptions {
  readonly config: BrazeRuntimeConfig;
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
  readonly secrets?: SecretResolver;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly startRuntime?: boolean;
}

export interface BuiltBrazeApp {
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

export async function buildBrazeApp(options: BuildAppOptions): Promise<BuiltBrazeApp> {
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
    component: "braze.runtime",
    vendor: CONSUMER_VENDOR,
    consumer_version: CONSUMER_VERSION,
  });

  // ---- PostgreSQL ----------------------------------------------------
  const { db, ownsDb } = buildDb(config, options.db);

  // ---- secrets -------------------------------------------------------
  const secrets =
    options.secrets ??
    new SecretResolver({
      adapters: {
        env: new EnvSecretProvider({ source: process.env }),
      },
    });

  // ---- consumer + producer ------------------------------------------
  // One AMQP connection per process, shared by the DLQ producer and the
  // analytics.events consumer. Checkpoints live in PostgreSQL because
  // RabbitMQ streams consumed over AMQP have no server-side offset store.
  const connection = createTransportConnection({ rabbitmq: config.rabbitmq, logger: consumerLogger });
  const checkpoints = new PostgresCheckpointStore(db);
  const { producer, ownsProducer } = buildProducer(
    config,
    options.producer,
    consumerLogger,
    connection,
  );
  const { consumer, ownsConsumer } = buildConsumer(
    config,
    options.consumer,
    consumerLogger,
    connection,
    checkpoints,
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
  const metrics = new DestinationMetrics();

  const descriptor = createBrazeDescriptor({
    requestTimeoutMs: config.braze.requestTimeoutMs,
    apiHost: config.braze.apiHost,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  const runtime = createDestinationConsumer({
    descriptor,
    consumerBuildVersion:
      config.service.releaseLabel ?? config.service.gitSha ?? config.service.serviceVersion,
    consumer,
    producer,
    instances,
    records,
    dlqRecords,
    secrets,
    logger: consumerLogger,
    allowReplay: config.braze.allowReplay,
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
        title: "Polaris braze v1",
        version: config.service.serviceVersion,
        description:
          "Destination consumer that POSTs canonical events into Braze's REST API. /health, /ready, and /metrics only — no business routes.",
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
 * `consumers/tiktok/v1/src/app.ts` and `apps/ingester-api/src/app.ts`:
 * user/password URL-encoded; sslmode explicit via URLSearchParams
 * ('require' or 'disable').
 */
function buildDb(
  config: BrazeRuntimeConfig,
  override: Kysely<Database> | undefined,
): { db: Kysely<Database>; ownsDb: boolean } {
  if (override !== undefined) {
    return { db: override, ownsDb: false };
  }
  const db = createDb({ postgres: config.postgres });
  return { db, ownsDb: true };
}

function buildProducer(
  config: BrazeRuntimeConfig,
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
    producerName: `${CONSUMER_VENDOR}-${CONSUMER_VERSION}`,
    producerVersion: config.service.serviceVersion,
  });
  return { producer, ownsProducer: true };
}

function buildConsumer(
  config: BrazeRuntimeConfig,
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
    consumerName: CONSUMER_VENDOR,
    consumerVersion: CONSUMER_VERSION,
    groupName: config.braze.consumerGroup,
    checkpoints,
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
