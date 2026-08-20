/**
 * merge-worker v1 process.
 *
 * Consumes `profile.events` and keeps `polaris.profile_merge_map` current.
 * The interesting parts are in `merge-map.ts` (what a merge means for the
 * map) and `runtime.ts` (which events it acts on); this file is the wiring
 * that turns them into a service.
 *
 * ## No DLQ producer
 *
 * Unlike the destination consumers, this worker publishes nothing. A
 * poisoned message on `profile.events` is the transport's to route, and the
 * two failures this worker can have — an undecodable payload and a merge
 * missing the fields the map needs — are counted and skipped rather than
 * thrown, because no retry produces a different answer for either. A
 * ClickHouse write failure IS rethrown, and the redelivery is safe because
 * the upsert is idempotent by construction.
 *
 * A poison producer is still wired: the transport needs one to park a
 * message it cannot hand to the handler at all, which is a layer below
 * anything this worker sees.
 */

import { createClickHouseClient } from "@polaris/persistence-clickhouse";
import { closeDb, createDb, type Database } from "@polaris/persistence-postgres";
import { createLogger } from "@polaris/observability-logger";
import { toPrometheusText } from "@polaris/observability-metrics";
import { ProcessorMetrics } from "@polaris/pipeline";
import {
  type BootstrappedService,
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ShutdownTask,
} from "@polaris/runtime-service-bootstrap";
import {
  consumerFamiliesFor,
  createPolarisConsumer,
  createPolarisProducer,
  createTransportConnection,
  type PolarisConsumer,
  PostgresCheckpointStore,
  STREAM_FAMILY_IDENTITY_EVENTS,
  startIsolationSnapshot,
} from "@polaris/bus";
import type { Kysely } from "kysely";

import type { MergeWorkerRuntimeConfig } from "./config.js";
import { createMergeHandler } from "./runtime.js";

export const PROCESSOR_COMPONENT = "merge-worker" as const;
export const PROCESSOR_VERSION = "v1" as const;

export interface BuildAppOptions {
  readonly config: MergeWorkerRuntimeConfig;
  readonly db?: Kysely<Database>;
  readonly consumer?: PolarisConsumer;
  readonly startRuntime?: boolean;
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;
}

export interface BuiltMergeWorkerApp {
  readonly bootstrap: BootstrappedService;
  readonly metrics: ProcessorMetrics;
  readonly db: Kysely<Database>;
  readonly ownsDb: boolean;
}

export async function buildMergeWorkerApp(options: BuildAppOptions): Promise<BuiltMergeWorkerApp> {
  const { config } = options;

  const logger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
    ...(config.service.releaseLabel !== undefined
      ? { releaseLabel: config.service.releaseLabel }
      : {}),
  });
  const workerLogger = logger.child({
    component: PROCESSOR_COMPONENT,
    processor_version: PROCESSOR_VERSION,
  });

  let db: Kysely<Database>;
  let ownsDb: boolean;
  if (options.db !== undefined) {
    db = options.db;
    ownsDb = false;
  } else {
    db = createDb({ postgres: config.postgres });
    ownsDb = true;
  }

  const metrics = new ProcessorMetrics();
  // `service` role, not `operator`. This worker reads and writes one table
  // and has no business with the operator escape hatch — the package refuses
  // to construct a client without a declared role for exactly that reason.
  const clickhouse = createClickHouseClient({
    url: config.clickhouse.url,
    role: "service",
    // The env schema names it `user`; the client wants `username`. One
    // rename, here, rather than a second credential shape in config.
    credential: {
      username: config.clickhouse.service.user,
      password: config.clickhouse.service.password,
    },
    database: config.clickhouse.database,
    application: `${PROCESSOR_COMPONENT}-${PROCESSOR_VERSION}`,
    logger: workerLogger,
  });

  const connection = createTransportConnection({
    rabbitmq: config.rabbitmq,
    logger: workerLogger,
  });
  const checkpoints = new PostgresCheckpointStore(db);
  const poisonProducer = createPolarisProducer({
    connection,
    logger: workerLogger,
    producerName: `${PROCESSOR_COMPONENT}-${PROCESSOR_VERSION}`,
    producerVersion: config.service.serviceVersion,
  });

  const consumer =
    options.consumer ??
    createPolarisConsumer({
      connection,
      logger: workerLogger,
      consumerName: PROCESSOR_COMPONENT,
      consumerVersion: PROCESSOR_VERSION,
      groupName: config.mergeWorker.consumerGroup,
      checkpoints,
      poison: { component: PROCESSOR_COMPONENT, producer: poisonProducer },
    });

  const handle = createMergeHandler({
    store: clickhouse.mergeMap,
    logger: workerLogger,
    metrics,
    identity: {
      processor_name: PROCESSOR_COMPONENT,
      processor_version: PROCESSOR_VERSION,
    },
  });

  // Topic isolation (0068R). This consumer was missed when the snapshot was
  // wired into the others, so an isolated project's `identity.events` would
  // have gone unread here even after the family was repointed.
  const isolationSnapshot = await startIsolationSnapshot({
    db,
    environment: config.service.environment,
    logger,
  });
  const isolatedProjects = isolationSnapshot.isolatedProjects(STREAM_FAMILY_IDENTITY_EVENTS);

  // Ordered: stop consuming before closing what the handler writes to.
  const shutdownTasks: ShutdownTask[] = [
    async () => {
      isolationSnapshot.stop();
    },
    async () => {
      await consumer.disconnect().catch(() => {});
    },
    async () => {
      await poisonProducer.disconnect().catch(() => {});
    },
    async () => {
      await clickhouse.close().catch(() => {});
    },
  ];
  if (ownsDb) {
    shutdownTasks.push(async () => {
      await closeDb(db).catch(() => {});
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
    logger: workerLogger,
    fastify: { bodyLimit: config.http.bodyLimitBytes, disableRequestLogging: true },
    openapi: {
      setup: NOOP_OPENAPI_SETUP,
      metadata: {
        title: "Polaris merge-worker v1",
        version: config.service.serviceVersion,
        description:
          "Keeps polaris.profile_merge_map current so person-keyed ClickHouse reads resolve a merged profile to its survivor. /health, /ready, and /metrics only.",
      },
    },
    shutdownTasks,
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
    metrics: { producer: () => toPrometheusText(metrics.getSamples()) },
  });

  if (options.startRuntime ?? true) {
    void (async () => {
      try {
        await poisonProducer.connect();
        await consumer.subscribe({
          families: consumerFamiliesFor(STREAM_FAMILY_IDENTITY_EVENTS, isolatedProjects),
        });
        await consumer.runEach(handle);
      } catch (err) {
        workerLogger.error({ err }, "merge worker terminated unexpectedly");
      }
    })();
  }

  return { bootstrap, metrics, db, ownsDb };
}
