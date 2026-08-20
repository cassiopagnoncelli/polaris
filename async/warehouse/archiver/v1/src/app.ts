/**
 * archiver v1 process.
 *
 * Wiring. The two pieces worth reading before this file are the
 * durability watermark in `@polaris/archive-writer/batcher.ts` and the
 * checkpoint clamp in `deferred-checkpoints.ts`; everything here exists to
 * connect them to a consumer, a bucket and a flush timer.
 *
 * ## The clamp is installed at construction, not opted into
 *
 * `createDeferredCheckpointStore` wraps the PostgreSQL store before the
 * consumer ever sees it. A wiring where the plain store could be passed by
 * mistake would make the archiver's one safety property a configuration
 * detail — and the failure mode is silent, because events that were never
 * written leave no gap to notice.
 *
 * ## No DLQ producer
 *
 * This worker publishes nothing. Its two failure modes — an undecodable
 * payload and an envelope with no usable `occurred_at` — are counted and
 * skipped, because no retry produces a different answer for either. A
 * failed PUT is not one of them: that batch stays in memory with the
 * checkpoint held behind it and is retried on the next flush.
 *
 * A poison producer is still wired, because the transport needs one to
 * park a message it cannot hand to the handler at all.
 */

import {
  ArchiveBatcher,
  type ArchiveObjectStore,
  createArchiveWriter,
  createDeferredCheckpointStore,
  createS3ArchiveStore,
} from "@polaris/archive-writer";
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
  STREAM_FAMILY_RAW_EVENTS,
} from "@polaris/bus";
import type { Kysely } from "kysely";

import type { ArchiverRuntimeConfig } from "./config.js";
import { createArchiveHandler, type FlushLoop, startFlushLoop } from "./runtime.js";

export const PROCESSOR_COMPONENT = "archiver" as const;
export const PROCESSOR_VERSION = "v1" as const;

export interface BuildAppOptions {
  readonly config: ArchiverRuntimeConfig;
  readonly db?: Kysely<Database>;
  readonly consumer?: PolarisConsumer;
  /** Injected in tests; production builds the S3 store from config. */
  readonly objectStore?: ArchiveObjectStore;
  readonly startRuntime?: boolean;
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;
}

export interface BuiltArchiverApp {
  readonly bootstrap: BootstrappedService;
  readonly metrics: ProcessorMetrics;
  readonly batcher: ArchiveBatcher;
  readonly flushLoop: FlushLoop;
  readonly db: Kysely<Database>;
  readonly ownsDb: boolean;
}

export async function buildArchiverApp(options: BuildAppOptions): Promise<BuiltArchiverApp> {
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
  const objectStore = options.objectStore ?? (await buildS3Store(config));

  const batcher = new ArchiveBatcher({
    maxBytes: config.archiver.maxBytes,
    maxRecords: config.archiver.maxRecords,
    maxAgeMs: config.archiver.maxAgeMs,
  });
  const writer = createArchiveWriter({
    store: objectStore,
    batcher,
    prefix: config.archiver.prefix,
    now: () => new Date(),
    onWritten: ({ key, records, projectId, environment }) => {
      metrics.incrementEmitted({
        processor_name: PROCESSOR_COMPONENT,
        processor_version: PROCESSOR_VERSION,
        project_id: projectId,
        environment,
      });
      workerLogger.info({ key, records }, "archived batch");
    },
    onFailed: ({ key, records, err }) => {
      metrics.incrementFailed({
        processor_name: PROCESSOR_COMPONENT,
        processor_version: PROCESSOR_VERSION,
        reason: "put_failed",
      });
      // The alert-worthy one. Every one of these holds the checkpoint
      // back, and a checkpoint that stops moving is only survivable for
      // as long as the stream's retention window.
      workerLogger.error({ err, key, records }, "archive put failed; batch requeued");
    },
    onManifestFailed: ({ key, err }) => {
      workerLogger.warn({ err, key }, "archive manifest append failed; object is safe");
    },
  });

  const connection = createTransportConnection({ rabbitmq: config.rabbitmq, logger: workerLogger });
  // Wrapped before the consumer sees it. See the module header.
  const checkpoints = createDeferredCheckpointStore({
    inner: new PostgresCheckpointStore(db),
    durableOffset: (stream) => batcher.durableOffset(stream),
    onClamped: ({ stream, requested, written }) => {
      workerLogger.debug(
        { stream, requested, written },
        "checkpoint held back to the archived offset",
      );
    },
  });
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
      groupName: config.archiver.consumerGroup,
      checkpoints,
      poison: { component: PROCESSOR_COMPONENT, producer: poisonProducer },
    });

  const handle = createArchiveHandler({
    batcher,
    logger: workerLogger,
    metrics,
    identity: {
      processor_name: PROCESSOR_COMPONENT,
      processor_version: PROCESSOR_VERSION,
    },
    now: () => Date.now(),
  });

  const flushLoop = startFlushLoop({
    flush: (nowMs, force) => writer.flush(nowMs, force),
    intervalMs: config.archiver.flushIntervalMs,
    now: () => Date.now(),
    onError: (err) => {
      workerLogger.error({ err }, "archive flush loop error");
    },
  });

  // Ordered: stop consuming, then flush what is buffered, then release
  // the database the checkpoint clamp writes through. Flushing after the
  // consumer stops is what keeps a deploy from re-reading a batch it
  // could have written.
  const shutdownTasks: ShutdownTask[] = [
    async () => {
      await consumer.disconnect().catch(() => {});
    },
    async () => {
      await flushLoop.stop();
    },
    async () => {
      await poisonProducer.disconnect().catch(() => {});
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
        title: "Polaris archiver v1",
        version: config.service.serviceVersion,
        description:
          "Writes raw.events to object storage as partitioned NDJSON so replay can reach past the stream's retention window. /health, /ready, and /metrics only.",
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
        await consumer.subscribe({ families: consumerFamiliesFor(STREAM_FAMILY_RAW_EVENTS, []) });
        await consumer.runEach(handle);
      } catch (err) {
        workerLogger.error({ err }, "archiver terminated unexpectedly");
      }
    })();
  }

  return { bootstrap, metrics, batcher, flushLoop, db, ownsDb };
}

/**
 * Build the S3 store.
 *
 * The SDK is imported dynamically so the package's other consumers — the
 * config schema, the handler, every test — do not pay for loading it, and
 * so a deployment that injects its own store never resolves it at all.
 */
async function buildS3Store(config: ArchiverRuntimeConfig): Promise<ArchiveObjectStore> {
  const s3 = await import("@aws-sdk/client-s3");
  const client = new s3.S3Client({
    region: config.archiver.region,
    ...(config.archiver.endpoint !== undefined ? { endpoint: config.archiver.endpoint } : {}),
    // MinIO addresses buckets by path, not by subdomain.
    forcePathStyle: config.archiver.forcePathStyle,
  });
  return createS3ArchiveStore({
    client,
    bucket: config.archiver.bucket,
    commands: {
      PutObjectCommand: s3.PutObjectCommand,
      GetObjectCommand: s3.GetObjectCommand,
      ListObjectsV2Command: s3.ListObjectsV2Command,
    },
  });
}
