/**
 * journey-orchestrator v1 bootstrap.
 *
 * Consumes `resolved.events` and `profile.events`, walks participants
 * through the graphs in `definitions/journeys/`, and publishes `journey.*`
 * back onto the profile plane. It holds no vendor credentials and reaches
 * no vendor: an action's event travels the ordinary destination path.
 *
 * ## It subscribes to the plane it publishes to
 *
 * `audience.entered` — the declarative trigger — rides `profile.events`,
 * and so does everything this service emits. The loop guard in
 * `runtime.ts` is what makes that safe, and it is checked on the way in
 * rather than relied on from the catalog alone.
 *
 * ## The sweep runs here, not on a separate schedule
 *
 * `polaris journeys sweep` exists for an operator, but a service that owns
 * a producer is the natural place for the loop: the sweep produces effects
 * and something has to publish them. Running it on an interval inside the
 * service means a wait elapsing does not depend on a crontab entry
 * somebody remembered to add.
 */

import { JOURNEY_DEFINITIONS, type JourneyDefinition } from "@polaris/journey-catalog";
import { closeDb, createDb, type Database } from "@polaris/persistence-postgres";
import { createLogger, type Logger } from "@polaris/observability-logger";
import { toPrometheusText } from "@polaris/observability-metrics";
import { ProcessorMetrics } from "@polaris/pipeline";
import {
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ShutdownTask,
} from "@polaris/runtime-service-bootstrap";
import {
  consumerFamiliesFor,
  createPolarisConsumer,
  createPolarisProducer,
  createTransportConnection,
  type IsolationSnapshot,
  type PolarisConsumer,
  type PolarisProducer,
  PostgresCheckpointStore,
  STREAM_FAMILY_PROFILE_EVENTS,
  STREAM_FAMILY_RESOLVED_EVENTS,
  startIsolationSnapshot,
} from "@polaris/bus";
import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

import {
  type JourneyOrchestratorRuntimeConfig,
  PROCESSOR_COMPONENT,
  PROCESSOR_SERVICE_NAME,
} from "./config.js";
import type { ProfileSnapshot } from "./engine.js";
import { createKyselyJourneyRepository, type JourneyRepository } from "./repository.js";
import {
  handleEvent,
  type IncomingEvent,
  type OutgoingEffect,
  PROCESSOR_VERSION,
} from "./runtime.js";
import { definitionKey, sweep } from "./sweep.js";

export interface BuildJourneyOrchestratorOptions {
  readonly config: JourneyOrchestratorRuntimeConfig;
  readonly db?: Kysely<Database>;
  readonly consumer?: PolarisConsumer;
  readonly producer?: PolarisProducer;
  readonly definitions?: readonly JourneyDefinition[];
  readonly startRuntime?: boolean;
  readonly installShutdown?: boolean;
  /** Sweep period. Set to 0 to disable the in-service loop. */
  readonly sweepIntervalMs?: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export async function buildJourneyOrchestratorApp(options: BuildJourneyOrchestratorOptions) {
  const config = options.config;
  const logger: Logger = createLogger({
    service: PROCESSOR_SERVICE_NAME,
    version: config.service.serviceVersion,
    env: config.service.environment,
  });
  const metrics = new ProcessorMetrics();
  const definitions = options.definitions ?? JOURNEY_DEFINITIONS;
  const byVersion = new Map(
    definitions.map((definition) => [
      definitionKey(definition.key, definition.version),
      definition,
    ]),
  );

  const ownsDb = options.db === undefined;
  const db = options.db ?? createDb({ postgres: config.postgres });
  const repository: JourneyRepository = createKyselyJourneyRepository(db);

  // Traits, as a branch reads them. Straight from the profile store — the
  // orchestrator never aggregates anything itself, it asks what the traits
  // runner already concluded.
  const readProfile = async (input: {
    readonly project_id: string;
    readonly environment: string;
    readonly profile_id: string;
  }): Promise<ProfileSnapshot> => {
    const row = await db
      .selectFrom("profiles")
      .select("traits")
      .where("profile_id", "=", input.profile_id)
      .executeTakeFirst();
    return {
      profile_id: input.profile_id,
      traits: (row?.traits ?? {}) as Record<string, unknown>,
    };
  };

  const connection = createTransportConnection({ rabbitmq: config.rabbitmq, logger });
  const producer =
    options.producer ??
    createPolarisProducer({
      connection,
      logger,
      producerName: `${PROCESSOR_COMPONENT}-${PROCESSOR_VERSION}`,
      producerVersion: config.service.serviceVersion,
    });

  // 0068R: both sides of isolation from one snapshot.
  const isolationSnapshot: IsolationSnapshot = await startIsolationSnapshot({
    db,
    environment: config.service.environment,
    logger,
  });

  const consumer =
    options.consumer ??
    createPolarisConsumer({
      connection,
      logger,
      consumerName: PROCESSOR_COMPONENT,
      consumerVersion: PROCESSOR_VERSION,
      groupName: config.orchestrator.consumerGroup,
      checkpoints: new PostgresCheckpointStore(db),
      poison: { component: PROCESSOR_COMPONENT, producer },
    });

  const run_id = `polaris_jrun_${uuidv7()}`;

  /** Publish one effect onto the profile plane. */
  async function publish(effect: OutgoingEffect): Promise<void> {
    await producer.publishEvent({
      family: STREAM_FAMILY_PROFILE_EVENTS,
      isolation: isolationSnapshot.lookup,
      event: {
        event_id: uuidv7(),
        event: effect.event,
        schema_version: 1,
        project_id: effect.project_id,
        environment: effect.environment,
        occurred_at: new Date().toISOString(),
        ingested_at: new Date().toISOString(),
        source: { id: `${PROCESSOR_COMPONENT}-${PROCESSOR_VERSION}`, type: "internal" },
        // No identity block: a journey event belongs to a PROFILE, and
        // inventing an identifier would claim this run saw one it never
        // touched. The profile block is how it names its person.
        identity: {},
        context: {},
        profile: { profile_id: effect.profile_id },
        properties: effect.properties,
        processor_name: PROCESSOR_COMPONENT,
        processor_version: PROCESSOR_VERSION,
      },
    });
  }

  const handler = async (payload: { message: { value: Buffer | null } }): Promise<void> => {
    const value = payload.message.value;
    if (value === null || value.length === 0) return;
    let event: IncomingEvent;
    try {
      event = JSON.parse(value.toString("utf8")) as IncomingEvent;
    } catch {
      // Undecodable payload. Dropping beats throwing: throwing rewinds the
      // partition and redelivers the same broken message forever, stalling
      // every healthy event behind it.
      logger.warn({ component: "journey-orchestrator.decode" }, "skipping undecodable payload");
      return;
    }

    const result = await handleEvent(event, {
      definitions,
      repository,
      readProfile,
      logger,
      now: () => new Date(),
      run_id,
    });
    for (const effect of result.published) await publish(effect);
  };

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  async function runSweepOnce(
    opts: { readonly limit?: number; readonly environment?: string } = {},
  ): Promise<{ claimed: number; advanced: number; orphaned: number; emitted: number }> {
    // The DATA environment, which is not always the service's own.
    // `config.service.environment` is where the process runs — `local` on a
    // developer's machine — while participants carry `development`,
    // `staging` or `production`, the only values the table's CHECK allows.
    // A local sweep defaulting to its own deployment environment would scan
    // for rows that cannot exist, find nothing, and report success.
    //
    // `polaris journeys sweep --env` supplies it explicitly, which is what
    // that flag is for; the in-service loop passes the service's, correct
    // for a deployed orchestrator where the two agree.
    const environment = opts.environment ?? config.service.environment;
    const result = await sweep({
      repository,
      definitions: byVersion,
      readProfile,
      environment,
      now: new Date(),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    for (const entry of result.emitted) {
      for (const effect of entry.effects) {
        if (effect.kind !== "emit") continue;
        await publish({
          event: effect.event,
          project_id: entry.participant.project_id,
          environment: entry.participant.environment,
          profile_id: entry.participant.profile_id,
          properties: {
            journey: entry.participant.journey,
            journey_version: entry.participant.journey_version,
            profile_id: entry.participant.profile_id,
            step_id: effect.step_id,
            run_id,
            ...(effect.from_step_id !== undefined ? { from_step_id: effect.from_step_id } : {}),
            ...(effect.properties !== undefined ? { properties: effect.properties } : {}),
            ...(effect.reason !== undefined ? { reason: effect.reason } : {}),
          },
        });
      }
    }
    if (result.claimed > 0) {
      logger.info(
        { component: "journey-orchestrator.sweep", ...result, emitted: result.emitted.length },
        "journey sweep finished",
      );
    }
    return {
      claimed: result.claimed,
      advanced: result.advanced,
      orphaned: result.orphaned,
      emitted: result.emitted.length,
    };
  }

  const shutdownTasks: ShutdownTask[] = [
    async () => {
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
    },
    async () => {
      isolationSnapshot.stop();
    },
    async () => {
      await consumer.disconnect().catch(() => {});
    },
    async () => {
      await producer.disconnect().catch(() => {});
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
    logger,
    fastify: {
      bodyLimit: config.http.bodyLimitBytes,
      disableRequestLogging: true,
    },
    openapi: {
      setup: NOOP_OPENAPI_SETUP,
      metadata: {
        title: "Polaris journey-orchestrator v1",
        version: config.service.serviceVersion,
        description:
          "Walks profiles through the versioned step graphs in definitions/journeys/, emitting journey.* onto the profile plane. Makes no vendor calls. /health, /ready, /metrics only.",
      },
    },
    shutdownTasks,
    installShutdown: options.installShutdown ?? true,
    metrics: { producer: () => toPrometheusText(metrics.getSamples()) },
  });

  async function start(): Promise<void> {
    await producer.connect();
    // Both families. `resolved.events` carries event triggers;
    // `profile.events` carries `audience.entered` — and this service's own
    // output, which the loop guard drops on arrival.
    const families = [
      ...consumerFamiliesFor(
        STREAM_FAMILY_RESOLVED_EVENTS,
        isolationSnapshot.isolatedProjects(STREAM_FAMILY_RESOLVED_EVENTS),
      ),
      ...consumerFamiliesFor(
        STREAM_FAMILY_PROFILE_EVENTS,
        isolationSnapshot.isolatedProjects(STREAM_FAMILY_PROFILE_EVENTS),
      ),
    ];
    await consumer.subscribe({ families });
    logger.info({ component: "journey-orchestrator.runtime", families }, "orchestrator subscribed");

    const interval = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      sweepTimer = setInterval(() => {
        void runSweepOnce().catch((err: unknown) => {
          logger.error({ component: "journey-orchestrator.sweep", err }, "sweep failed");
        });
      }, interval);
      sweepTimer.unref?.();
    }

    await consumer.runEach(handler);
  }

  if (options.startRuntime ?? true) {
    void start().catch((err: unknown) => {
      logger.error({ err }, "journey orchestrator terminated unexpectedly");
    });
  }

  return { bootstrap, start, handler, runSweepOnce, repository, metrics, publish };
}
