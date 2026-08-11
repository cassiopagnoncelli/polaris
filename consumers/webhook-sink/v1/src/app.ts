/**
 * Service bootstrap for webhook-sink v1.
 *
 * The webhook-sink consumer runs as a standalone Node service. The shape
 * mirrors the analytics-projector skeleton (`processors/analytics-projector/
 * v1/src/app.ts`):
 *
 *   1. Build a structured logger from `@polaris/shared-logger`.
 *   2. Build the PostgreSQL `Kysely<Database>` over the shared-config pool.
 *   3. Build the KafkaJS client + `PolarisConsumer` (analytics.events) +
 *      `PolarisProducer` (DLQ publishes only).
 *   4. Build the `DestinationConsumer` runtime from the webhook-sink
 *      descriptor and wire it to:
 *        - `createKyselyDestinationInstanceReader` wrapped in
 *          `DestinationInstanceCache` (per-event lookup)
 *        - `createKyselyDeliveryRecordRepository` (delivery_records)
 *        - `SecretResolver` with the env-backed adapter
 *        - a fresh `DestinationMetrics` registry threaded into `/metrics`
 *   5. Hand the runtime's `start`/`stop` and the consumer/producer/db
 *      lifecycles to `bootstrapService`:
 *        - `/health` and `/ready` come from the bootstrap
 *        - `/metrics` serves the Prometheus text format from the live registry
 *        - shutdown tasks stop the runtime, disconnect the consumer +
 *          producer, then end the Kysely pool in that order
 *
 * Tests inject pre-built consumer + producer + instance reader + records
 * repo + secrets through the `BuildAppOptions` slots so they can drive
 * the runtime without a real RabbitMQ broker or PostgreSQL.
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
  createKafkaClient,
  createPolarisConsumer,
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

import type { WebhookSinkRuntimeConfig } from "./config.js";
import { createWebhookSinkDescriptor } from "./descriptor.js";
import { CONSUMER_VENDOR, CONSUMER_VERSION } from "./descriptor-identity.js";

/**
 * Options accepted by `buildWebhookSinkApp`.
 *
 * Tests override `consumer`, `producer`, `db`, `instances`, `records`, and
 * `secrets` to drive the runtime in isolation.
 */
export interface BuildAppOptions {
  readonly config: WebhookSinkRuntimeConfig;
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
   */
  readonly consumer?: PolarisConsumer;
  /**
   * Pre-built producer. When supplied, the app does NOT call
   * `connect()` or `disconnect()`; the caller owns the lifecycle.
   */
  readonly producer?: PolarisProducer;
  /**
   * Pre-built Kysely client. When supplied, the app does NOT call
   * `closeDb()` on shutdown.
   */
  readonly db?: Kysely<Database>;
  /** Pre-built `DestinationInstanceReader`. Default: Kysely-backed + cache. */
  readonly instances?: DestinationInstanceReader;
  /** Pre-built `DeliveryRecordRepository`. Default: Kysely-backed. */
  readonly records?: DeliveryRecordRepository;
  /**
   * Pre-built `DlqRecordRepository`. Default: Kysely-backed. The runtime
   * writes a row alongside the Kafka DLQ publish so `polaris dlq list`
   * (P9-007) surfaces every triage entry. Tests inject the in-memory
   * adapter.
   */
  readonly dlqRecords?: DlqRecordRepository;
  /**
   * Pre-built secret resolver. Default: env-only resolver (production wires
   * a Vault / file adapter through `@polaris/shared-secrets`).
   */
  readonly secrets?: SecretResolver;
  /** `fetch`-compatible deliverer implementation. Default: `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Override of `() => new Date()` for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Whether to start the destination consumer runtime as part of bootstrap.
   * Defaults to `true` for production; tests set this to `false` and drive
   * the runtime's `handler` directly.
   */
  readonly startRuntime?: boolean;
}

/**
 * Outcome of `buildWebhookSinkApp`. Bundles the Fastify bootstrap with the
 * runtime handle so the binary entry point can call `runtime.start()` and
 * `runtime.stop()` deterministically.
 */
export interface BuiltWebhookSinkApp {
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

export async function buildWebhookSinkApp(options: BuildAppOptions): Promise<BuiltWebhookSinkApp> {
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
    component: "webhook-sink.runtime",
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
  const { producer, ownsProducer } = buildProducer(config, options.producer, consumerLogger);
  const { consumer, ownsConsumer } = buildConsumer(config, options.consumer, consumerLogger);
  if (ownsProducer) {
    try {
      await producer.connect();
    } catch (err) {
      consumerLogger.error({ err: errSummary(err) }, "destination DLQ producer failed to connect");
    }
  }
  if (ownsConsumer) {
    try {
      await consumer.connect();
    } catch (err) {
      consumerLogger.error({ err: errSummary(err) }, "analytics.events consumer failed to connect");
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

  const descriptor = createWebhookSinkDescriptor({
    requestTimeoutMs: config.sink.requestTimeoutMs,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
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
    allowReplay: config.sink.allowReplay,
    metrics,
    partitionsConsumedConcurrently: config.sink.partitionsConsumedConcurrently,
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
        title: "Polaris webhook-sink v1",
        version: config.service.serviceVersion,
        description:
          "Destination consumer that POSTs canonical events as JSON to a configurable HTTPS endpoint. /health, /ready, and /metrics only — no business routes.",
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

function buildDb(
  config: WebhookSinkRuntimeConfig,
  override: Kysely<Database> | undefined,
): { db: Kysely<Database>; ownsDb: boolean } {
  if (override !== undefined) {
    return { db: override, ownsDb: false };
  }
  const connectionString = buildConnectionString(config);
  const db = createDb({ connectionString, maxConnections: config.postgres.poolMax });
  return { db, ownsDb: true };
}

/**
 * Build a libpq-style connection string. Mirrors
 * `apps/ingester-api/src/app.ts`'s `buildDb` so SSL semantics stay
 * consistent across services — sslmode is explicit (`require` or
 * `disable`) rather than implicit via omission.
 *
 * Username + password are URL-encoded because operator-supplied secrets
 * routinely contain `@`, `:`, `/`, or `%`; host + database are left raw
 * because PostgreSQL doesn't accept percent-encoding there and operator
 * inputs are expected to be DNS-safe / SQL-identifier-safe.
 */
function buildConnectionString(config: WebhookSinkRuntimeConfig): string {
  const pg = config.postgres;
  const params = new URLSearchParams();
  params.set("sslmode", pg.ssl ? "require" : "disable");
  return `postgres://${encodeURIComponent(pg.user)}:${encodeURIComponent(pg.password)}@${pg.host}:${pg.port}/${pg.database}?${params.toString()}`;
}

function buildProducer(
  config: WebhookSinkRuntimeConfig,
  override: PolarisProducer | undefined,
  logger: Logger,
): { producer: PolarisProducer; ownsProducer: boolean } {
  if (override !== undefined) {
    return { producer: override, ownsProducer: false };
  }
  const kafka = createKafkaClient({ redpanda: config.rabbitmq });
  const producer = createPolarisProducer({
    kafka,
    logger,
    producerName: `${CONSUMER_VENDOR}-${CONSUMER_VERSION}`,
    producerVersion: config.service.serviceVersion,
  });
  return { producer, ownsProducer: true };
}

function buildConsumer(
  config: WebhookSinkRuntimeConfig,
  override: PolarisConsumer | undefined,
  logger: Logger,
): { consumer: PolarisConsumer; ownsConsumer: boolean } {
  if (override !== undefined) {
    return { consumer: override, ownsConsumer: false };
  }
  const kafka = createKafkaClient({ redpanda: config.rabbitmq });
  const consumer = createPolarisConsumer({
    kafka,
    logger,
    consumerName: CONSUMER_VENDOR,
    consumerVersion: CONSUMER_VERSION,
    consumerConfig: {
      groupId: config.sink.consumerGroup,
    },
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
