/**
 * Service bootstrap for the enrichment stage (sync/enrichment/runtime v1).
 *
 * Same lifecycle as the identity stage next door, with two differences
 * that matter:
 *
 *   1. The PostgreSQL handle becomes a READER and nothing else. The
 *      profile store's only sync-path writer is the identity stage; this
 *      process never acquires a write path to it.
 *   2. The geo backend is opened here, once, at boot. A missing or
 *      unreadable database logs a warning and falls back to the
 *      fail-open no-op rather than refusing to start — geo is decoration
 *      on the spine, and every destination sits behind this stage.
 *
 * Steps: logger → Postgres reader → transport consumer/producer →
 * activation gate → processor run → geo backend → runtime → shutdown
 * tasks → Fastify shell.
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
  type TransportConnection,
  type TransportHooks,
} from "@polaris/shared-transport";
import { type IPLookup, NoOpIPLookup, openMaxmindLookup } from "@polaris/sync-enrichment-geoip-v1";
import { createKyselyProfileReader, type ProfileReader } from "@polaris/sync-enrichment-traits-v1";
import type { Kysely } from "kysely";

import type { SyncEnrichmentRuntimeConfig } from "./config.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION } from "./pins.js";
import { createPolicyResolver, type ProjectEnrichmentOverride } from "./policy.js";
import { createRuntime, type EnrichmentStageRuntime } from "./runtime.js";

export interface BuildAppOptions {
  readonly config: SyncEnrichmentRuntimeConfig;
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;

  // ---- pluggable subsystem overrides ------------------------------------

  readonly consumer?: PolarisConsumer;
  readonly producer?: PolarisProducer;
  readonly db?: Kysely<Database>;
  /** Read-only profile access. Tests inject an in-memory reader. */
  readonly reader?: ProfileReader;
  /** Geo backend. Absent means "open the configured mmdb, else no-op". */
  readonly lookup?: IPLookup;
  readonly isolatedProjects?: ReadonlyArray<string>;
  readonly now?: () => Date;
  readonly startRuntime?: boolean;
  readonly runRepository?: ProcessorRunRepository;
  readonly recordRun?: boolean;
  readonly gate?: ProcessorActivationGate;
  /**
   * Per-project enrichment overrides, keyed by `project_id`. `main.ts`
   * loads these from the `enrichment:` blocks of `catalog/projects/`.
   * Validated EAGERLY here, so an out-of-bounds override fails this
   * build call — and therefore the boot — rather than throwing per
   * message inside the consumer handler.
   */
  readonly projectPolicies?: ReadonlyMap<string, ProjectEnrichmentOverride>;
}

export interface BuiltSyncEnrichmentApp {
  readonly bootstrap: BootstrappedService;
  readonly runtime: EnrichmentStageRuntime;
  readonly producer: PolarisProducer;
  readonly consumer: PolarisConsumer;
  readonly db: Kysely<Database>;
  readonly reader: ProfileReader;
  readonly lookup: IPLookup;
  readonly metrics: ProcessorMetrics;
  readonly ownsProducer: boolean;
  readonly ownsConsumer: boolean;
  readonly ownsDb: boolean;
  readonly run: ProcessorRunHandle;
}

export async function buildSyncEnrichmentApp(
  options: BuildAppOptions,
): Promise<BuiltSyncEnrichmentApp> {
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
  const transportHooks = createProcessorTransportHooks({
    logger: processorLogger,
    metrics,
    identity: PROCESSOR_IDENTITY,
  });

  // ---- PostgreSQL, read-only ------------------------------------------
  const { db, ownsDb } = buildDb(config, options.db);
  const reader = options.reader ?? createKyselyProfileReader(db);

  // ---- consumer + producer --------------------------------------------
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
        { component: "sync-enrichment.producer", err: errSummary(err) },
        "enrichment stage producer failed to connect",
      );
    }
  }

  // ---- geo backend -----------------------------------------------------
  const lookup = options.lookup ?? openConfiguredLookup(config, processorLogger);

  // ---- activation gate -------------------------------------------------
  const gate =
    options.gate ??
    createProcessorActivationGate({
      identity: PROCESSOR_IDENTITY,
      db: checkpointDb,
      logger: processorLogger,
    });

  const lag = createLagReporter({ metrics, identity: PROCESSOR_IDENTITY });

  // ---- processor run ---------------------------------------------------
  const run = await openProcessorRun({
    enabled: options.recordRun ?? true,
    ...(options.runRepository !== undefined ? { repository: options.runRepository } : {}),
    db: checkpointDb,
    identity: PROCESSOR_IDENTITY,
    environment: config.service.environment,
    host: hostname(),
    logger: processorLogger,
    metrics,
  });

  // ---- streaming runtime ----------------------------------------------
  const policyFor = createPolicyResolver(options.projectPolicies ?? new Map());

  const runtime = createRuntime({
    consumer,
    producer,
    reader,
    lookup,
    logger: processorLogger,
    policyFor,
    runId: () => run.run_id,
    now: options.now ?? (() => new Date()),
    metrics: {
      onEmitted: () => {
        metrics.incrementEmitted({
          processor_name: PROCESSOR_NAME,
          processor_version: PROCESSOR_VERSION,
        });
      },
      onSkipped: (reason: string) => {
        metrics.incrementSkipped({
          processor_name: PROCESSOR_NAME,
          processor_version: PROCESSOR_VERSION,
          reason,
        });
      },
      onOutcome: (outcome: string) => {
        metrics.incrementOutcome({
          processor_name: PROCESSOR_NAME,
          processor_version: PROCESSOR_VERSION,
          outcome,
        });
      },
    },
    isEnabled: async (projectId: string, environment: string) =>
      gate.isEnabled({ project_id: projectId, environment }),
    ...(options.isolatedProjects !== undefined
      ? { isolatedProjects: options.isolatedProjects }
      : {}),
  });
  void lag;

  // ---- shutdown tasks --------------------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  shutdownTasks.push(async () => {
    try {
      await runtime.stop();
    } catch (err) {
      processorLogger.warn(
        { component: "sync-enrichment.runtime", err: errSummary(err) },
        "runtime stop error during shutdown",
      );
    }
  });
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
          { component: "sync-enrichment.consumer", err: errSummary(err) },
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
          { component: "sync-enrichment.producer", err: errSummary(err) },
          "producer disconnect error during shutdown",
        );
      }
    });
  }
  shutdownTasks.push(async () => {
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
          { component: "sync-enrichment.db", err: errSummary(err) },
          "postgres pool close error during shutdown",
        );
      }
    });
  }
  if (options.shutdownTasks !== undefined) {
    shutdownTasks.push(...options.shutdownTasks);
  }

  // ---- readiness -------------------------------------------------------
  // The transport is load-bearing: without it nothing reaches
  // resolved.events and the pod would claim partitions it cannot serve.
  // The geo database deliberately is NOT a readiness condition — running
  // without it is a supported posture, and gating readiness on it would
  // turn a decoration outage into an outage.
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
        title: "Polaris enrichment stage (sync/enrichment/runtime v1)",
        version: config.service.serviceVersion,
        description:
          "Stage 3 of the main pipeline. Reads identified.events, composes the pinned enrichers in-process (traits snapshot from the profile store, geo from context.ip), and emits resolved.events. Reads the profile store; never writes it. /health, /ready, /metrics only.",
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
        { component: "sync-enrichment.runtime", err: errSummary(err) },
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
    reader,
    lookup,
    metrics,
    ownsProducer,
    ownsConsumer,
    ownsDb,
    run,
  };
}

/**
 * Open the configured geo database, or fall back to the no-op.
 *
 * Both fallback paths log at warn with the reason, because "we are
 * running without geo" is an operational fact someone should be able to
 * find in the boot log rather than infer from a month of null country
 * codes.
 */
function openConfiguredLookup(config: SyncEnrichmentRuntimeConfig, logger: Logger): IPLookup {
  const path = config.stage.geoipDbPath;
  if (path === undefined) {
    logger.warn(
      { component: "sync-enrichment.geoip" },
      "no POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH configured; geo enrichment runs fail-open (source: no_lookup)",
    );
    return new NoOpIPLookup();
  }

  const outcome = openMaxmindLookup(path);
  if (outcome.kind === "absent") {
    logger.warn(
      { component: "sync-enrichment.geoip", db_path: path, reason: outcome.reason },
      "geoip database could not be opened; geo enrichment runs fail-open (source: no_lookup)",
    );
    return new NoOpIPLookup();
  }

  logger.info(
    { component: "sync-enrichment.geoip", db_path: path, source: outcome.lookup.id },
    "geoip database loaded",
  );
  return outcome.lookup;
}

function buildDb(
  config: SyncEnrichmentRuntimeConfig,
  override: Kysely<Database> | undefined,
): { db: Kysely<Database>; ownsDb: boolean } {
  if (override !== undefined) {
    return { db: override, ownsDb: false };
  }
  const db = createDb({ postgres: config.postgres });
  return { db, ownsDb: true };
}

function buildProducer(
  config: SyncEnrichmentRuntimeConfig,
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
  config: SyncEnrichmentRuntimeConfig,
  override: PolarisConsumer | undefined,
  logger: Logger,
  hooks: TransportHooks,
  connection: TransportConnection,
  checkpoints: PostgresCheckpointStore,
  producer: PolarisProducer,
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
      component: "sync-enrichment",
      producer,
      record: recordDlq,
    },
    groupName: config.stage.consumerGroup,
    checkpoints,
  });
  return { consumer, ownsConsumer: true };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
