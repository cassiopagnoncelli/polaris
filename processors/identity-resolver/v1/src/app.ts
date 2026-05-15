/**
 * Service bootstrap for identity-resolver v1.
 *
 * Mirrors `processors/sessionizer/v1/src/app.ts` with the addition of
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
 * Redpanda or PostgreSQL.
 */

import { closeDb, createDb, type Database } from "@polaris/shared-db";
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

  // ---- PostgreSQL + repository ----------------------------------------
  const { db, ownsDb } = buildDb(config, options.db);
  const repository = options.repository ?? createKyselyIdentityLinkRepository({ db });

  // ---- consumer + producer --------------------------------------------
  const { producer, ownsProducer } = buildProducer(config, options.producer, processorLogger);
  const { consumer, ownsConsumer } = buildConsumer(config, options.consumer, processorLogger);

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
  if (ownsConsumer) {
    try {
      await consumer.connect();
    } catch (err) {
      processorLogger.error(
        { component: "identity-resolver.consumer", err: errSummary(err) },
        "raw.events consumer failed to connect",
      );
    }
  }

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
    partitionsConsumedConcurrently: config.resolver.partitionsConsumedConcurrently,
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
  };
}

function buildDb(
  config: IdentityResolverRuntimeConfig,
  override: Kysely<Database> | undefined,
): { db: Kysely<Database>; ownsDb: boolean } {
  if (override !== undefined) {
    return { db: override, ownsDb: false };
  }
  const pg = config.postgres;
  const params = new URLSearchParams();
  params.set("sslmode", pg.ssl ? "require" : "disable");
  const connectionString = `postgres://${encodeURIComponent(pg.user)}:${encodeURIComponent(pg.password)}@${pg.host}:${pg.port}/${pg.database}?${params.toString()}`;
  const db = createDb({ connectionString, maxConnections: pg.poolMax });
  return { db, ownsDb: true };
}

function buildProducer(
  config: IdentityResolverRuntimeConfig,
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
  config: IdentityResolverRuntimeConfig,
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
      groupId: config.resolver.consumerGroup,
    },
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
