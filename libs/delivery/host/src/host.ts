/**
 * The destination host: everything a vendor consumer's `app.ts` used to do
 * itself.
 *
 * The five consumers had ~413 lines each and, after substituting the vendor
 * name, differed by about a dozen. That is not duplication for its own sake —
 * it is five independent chances to answer the same question differently, and
 * they already had. The transport-hooks wiring was added to fix "every
 * lifecycle event went into `undefined`", and it had to be added five times;
 * `webhook-sink` asked the broker for a queue named after its VENDOR while
 * the topology declares queues by COMPONENT, and died on boot with NOT_FOUND
 * while four consumers worked by coincidence.
 *
 * What is genuinely per-vendor is small: an identity, a descriptor, a
 * project-config namespace, and one config section only that vendor's
 * deliverer reads. Everything else — Postgres, the AMQP connection,
 * checkpoints, the DLQ producer, the instance cache, the project-config
 * store and its LISTEN connection, the Redis-backed dedupe and limiter,
 * shutdown ordering, the Fastify shell — is platform.
 *
 * ## Shutdown order is a contract, not a detail
 *
 * The tasks are pushed in the order they must run: stop the runtime first so
 * no new delivery starts, then disconnect the consumer, then the producer,
 * then the project-config store, then the pool. The store is closed
 * separately from the pool and before it because its LISTEN connection is
 * its own `pg` client rather than one the Kysely pool hands out — `closeDb`
 * does not reach it, and leaving it open holds a backend open on the
 * database after a graceful shutdown. That reasoning lived in five copies of
 * a comment; it now lives in one place that enforces it.
 *
 * ## What the host does NOT own
 *
 * Anything a caller injects. Every `owns*` flag exists so a test can hand in
 * its own producer, consumer or pool and have the host leave the lifecycle
 * alone — a shutdown task that disconnected an injected consumer would tear
 * down something the caller is still using.
 */

import { PROJECT_POLICY_OVERRIDES } from "@polaris/policy-catalog";
import {
  closeDb,
  createDb,
  type Database,
  postgresConnectionString,
} from "@polaris/persistence-postgres";
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
  type DestinationDescriptor,
  DestinationInstanceCache,
  type DestinationInstanceReader,
  DestinationMetrics,
  type DestinationRateLimiterLike,
  type DestinationRedisConfig,
  type DlqRecordRepository,
  type ProjectConfigLookup,
} from "@polaris/delivery-destinations";
import type { Logger } from "@polaris/observability-logger";
import { createLogger } from "@polaris/observability-logger";
import { toPrometheusText } from "@polaris/observability-metrics";
import type { ProjectPolicyOverride } from "@polaris/governance";
import {
  createDestinationProjectConfigLookup,
  createPgListenerTransport,
  createProjectConfigStore,
  type ProjectConfigStore,
} from "@polaris/tenancy-project-config";
import {
  type BootstrappedService,
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/runtime-service-bootstrap";
import {
  type CanonicalStreamFamily,
  createPolarisConsumer,
  createPolarisProducer,
  createTransportConnection,
  type PolarisConsumer,
  type PolarisProducer,
  PostgresCheckpointStore,
  startIsolationSnapshot,
  type TransportConnection,
  type TransportHooks,
} from "@polaris/bus";
import type { Kysely } from "kysely";

/** The config sections every destination host needs. Vendors add their own. */
export interface DestinationHostConfig {
  readonly service: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly environment: string;
    readonly gitSha?: string | undefined;
    readonly buildTime?: string | undefined;
    readonly releaseLabel?: string | undefined;
  };
  readonly http: { readonly bodyLimitBytes: number };
  readonly rabbitmq: NonNullable<Parameters<typeof createTransportConnection>[0]["rabbitmq"]>;
  readonly postgres: NonNullable<Parameters<typeof createDb>[0]["postgres"]>;
  readonly redis: DestinationRedisConfig;
}

/** Overrides a caller may inject. Everything here suppresses host ownership. */
export interface DestinationHostOverrides<Payload> {
  readonly db?: Kysely<Database>;
  readonly producer?: PolarisProducer;
  readonly consumer?: PolarisConsumer;
  readonly instances?: DestinationInstanceReader;
  readonly records?: DeliveryRecordRepository;
  readonly dlqRecords?: DlqRecordRepository;
  readonly projectConfigStore?: ProjectConfigStore;
  readonly dedupe?: DestinationDedupe;
  readonly rateLimiter?: DestinationRateLimiterLike;
  readonly projectConfig?: ProjectConfigLookup;
  /**
   * Forbidden-field overrides for the delivery-side second pass.
   * Defaults to the deploy-time `@polaris/policy-catalog` registry — the
   * same map the ingester loads at intake. Tests inject a fixture map;
   * an empty map means platform defaults for every project.
   */
  readonly projectPolicies?: ReadonlyMap<string, ProjectPolicyOverride>;
  readonly now?: () => Date;
  readonly readinessProbes?: readonly ReadinessProbe[];
  readonly shutdownTasks?: readonly ShutdownTask[];
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;
  readonly startRuntime?: boolean;
  /** Descriptor built by the caller, so vendor options stay vendor-shaped. */
  readonly descriptor?: DestinationDescriptor<Payload>;
}

export interface DestinationHostInput<Payload, Config extends DestinationHostConfig> {
  readonly config: Config;
  /** Vendor + per-stage versions. Also names the queue topology component. */
  readonly descriptor: DestinationDescriptor<Payload>;
  /** Project-config namespace this consumer reads. */
  readonly projectConfigNamespace: string;
  /**
   * Families to consume. A single family or a list.
   *
   * A list is how a vendor reads the profile plane alongside the event
   * spine — `audience.entered` and `profile.updated` live on
   * `profile.events`, and nothing downstream of the subscription differs
   * between the two planes (see `DestinationConsumerOptions.inputFamily`).
   */
  readonly inputFamily: CanonicalStreamFamily | readonly CanonicalStreamFamily[];
  /** Per-instance replay opt-in still gates each delivery; this is the host half. */
  readonly allowReplay: boolean;
  /** Consumer group name, from the vendor's own config section. */
  readonly consumerGroup: string;
  /** One line for the OpenAPI shell, so `/health` explains what this is. */
  readonly description: string;
  readonly overrides: DestinationHostOverrides<Payload>;
}

export interface BuiltDestinationHost {
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

export async function buildDestinationHost<Payload, Config extends DestinationHostConfig>(
  input: DestinationHostInput<Payload, Config>,
): Promise<BuiltDestinationHost> {
  const { config, descriptor, overrides } = input;
  const identity = descriptor.identity;

  const logger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
    ...(config.service.releaseLabel !== undefined
      ? { releaseLabel: config.service.releaseLabel }
      : {}),
  });
  const consumerLogger = logger.child({
    component: `${identity.component}.runtime`,
    vendor: identity.vendor,
    consumer_version: identity.consumerVersion,
  });

  // Written as a statement rather than a ternary so the two branches do not
  // widen `db` into a union TypeScript then refuses to pass anywhere.
  let db: Kysely<Database>;
  let ownsDb: boolean;
  if (overrides.db !== undefined) {
    db = overrides.db;
    ownsDb = false;
  } else {
    db = createDb({ postgres: config.postgres });
    ownsDb = true;
  }

  // Built before the transport because the hooks need the registry: passing
  // no hooks meant every lifecycle event the consumer emitted — poisoned,
  // rewound, partition_assigned — went into `undefined`.
  const metrics = new DestinationMetrics();
  const transportHooks = createDestinationTransportHooks({
    logger: consumerLogger,
    metrics,
    vendor: identity.vendor,
    consumerVersion: identity.consumerVersion,
  });

  // One AMQP connection per process, shared by the DLQ producer and the
  // stream consumer. Checkpoints live in PostgreSQL because RabbitMQ streams
  // consumed over AMQP have no server-side offset store.
  const connection = createTransportConnection({
    rabbitmq: config.rabbitmq,
    logger: consumerLogger,
  });
  const checkpoints = new PostgresCheckpointStore(db);

  const { producer, ownsProducer } = buildProducer(
    config,
    overrides.producer,
    consumerLogger,
    connection,
    transportHooks,
    identity.vendor,
    identity.consumerVersion,
  );
  const { consumer, ownsConsumer } = buildConsumer(
    overrides.consumer,
    consumerLogger,
    connection,
    checkpoints,
    producer,
    transportHooks,
    identity.vendor,
    identity.consumerVersion,
    identity.component,
    input.consumerGroup,
  );
  if (ownsProducer) {
    try {
      await producer.connect();
    } catch (err) {
      consumerLogger.error({ err: errSummary(err) }, "destination DLQ producer failed to connect");
    }
  }

  const instances =
    overrides.instances ??
    new DestinationInstanceCache({ reader: createKyselyDestinationInstanceReader({ db }) });
  const records = overrides.records ?? createKyselyDeliveryRecordRepository({ db });
  const dlqRecords = overrides.dlqRecords ?? createKyselyDlqRecordRepository({ db });

  const projectConfigStore =
    overrides.projectConfigStore ??
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
      { component: `${identity.component}.project-config`, err },
      "project-config store failed to start; using deployment defaults",
    );
  });

  const sharedState = await createDestinationSharedState({
    redis: config.redis,
    logger: consumerLogger,
  });

  // Topic isolation. `consumerFamiliesFor(family, [])` was hardcoded in the
  // destination runtime, so once a project was isolated its events landed
  // on a dedicated stream no destination read and were delivered nowhere --
  // the one consumer class in the platform that could not even be TOLD
  // about isolation. Wired here rather than in each vendor's app because
  // all five route through this host.
  const isolationSnapshot = await startIsolationSnapshot({
    db,
    environment: config.service.environment,
    logger: consumerLogger,
  });

  const runtime = createDestinationConsumer({
    descriptor,
    inputFamily: input.inputFamily,
    isolation: isolationSnapshot,
    consumerBuildVersion:
      config.service.releaseLabel ?? config.service.gitSha ?? config.service.serviceVersion,
    consumer,
    producer,
    instances,
    records,
    dlqRecords,
    logger: consumerLogger,
    allowReplay: input.allowReplay,
    dedupe: overrides.dedupe ?? sharedState.dedupe,
    rateLimiter: overrides.rateLimiter ?? sharedState.rateLimiter,
    projectConfig:
      overrides.projectConfig ??
      createDestinationProjectConfigLookup({
        store: projectConfigStore,
        namespace: input.projectConfigNamespace,
      }),
    projectPolicies: overrides.projectPolicies ?? PROJECT_POLICY_OVERRIDES,
    metrics,
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });

  // Order is the contract — see the module header.
  const shutdownTasks: ShutdownTask[] = [];
  const guarded = (what: string, fn: () => Promise<unknown>): ShutdownTask => {
    return async () => {
      try {
        await fn();
      } catch (err) {
        consumerLogger.warn({ err: errSummary(err) }, `${what} error during shutdown`);
      }
    };
  };
  shutdownTasks.push(
    guarded("isolation snapshot stop", async () => {
      isolationSnapshot.stop();
    }),
  );
  shutdownTasks.push(guarded("destination runtime stop", () => runtime.stop()));
  if (ownsConsumer) shutdownTasks.push(guarded("consumer disconnect", () => consumer.disconnect()));
  if (ownsProducer) shutdownTasks.push(guarded("producer disconnect", () => producer.disconnect()));
  shutdownTasks.push(guarded("project-config store close", () => projectConfigStore.close()));
  if (ownsDb) shutdownTasks.push(guarded("postgres pool close", () => closeDb(db)));
  if (overrides.shutdownTasks !== undefined) shutdownTasks.push(...overrides.shutdownTasks);

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
    fastify: { bodyLimit: config.http.bodyLimitBytes, disableRequestLogging: true },
    ...(overrides.readinessProbes !== undefined
      ? { readinessProbes: overrides.readinessProbes }
      : {}),
    openapi: {
      setup: NOOP_OPENAPI_SETUP,
      metadata: {
        title: `Polaris ${identity.component} ${identity.consumerVersion}`,
        version: config.service.serviceVersion,
        description: input.description,
      },
    },
    ...(shutdownTasks.length > 0 ? { shutdownTasks } : {}),
    installShutdown: overrides.installShutdown ?? true,
    ...(overrides.shutdownExit !== undefined ? { shutdownExit: overrides.shutdownExit } : {}),
    metrics: { producer: () => toPrometheusText(metrics.getSamples()) },
  });

  if (overrides.startRuntime ?? true) {
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

function buildProducer(
  config: DestinationHostConfig,
  override: PolarisProducer | undefined,
  logger: Logger,
  connection: TransportConnection,
  hooks: TransportHooks,
  vendor: string,
  consumerVersion: string,
): { producer: PolarisProducer; ownsProducer: boolean } {
  if (override !== undefined) return { producer: override, ownsProducer: false };
  return {
    producer: createPolarisProducer({
      connection,
      logger,
      hooks,
      producerName: `${vendor}-${consumerVersion}`,
      producerVersion: config.service.serviceVersion,
    }),
    ownsProducer: true,
  };
}

function buildConsumer(
  override: PolarisConsumer | undefined,
  logger: Logger,
  connection: TransportConnection,
  checkpoints: PostgresCheckpointStore,
  producer: PolarisProducer,
  hooks: TransportHooks,
  vendor: string,
  consumerVersion: string,
  component: string,
  groupName: string,
): { consumer: PolarisConsumer; ownsConsumer: boolean } {
  if (override !== undefined) return { consumer: override, ownsConsumer: false };
  return {
    consumer: createPolarisConsumer({
      connection,
      logger,
      hooks,
      consumerName: vendor,
      consumerVersion,
      // `component`, not `vendor`. The topology is declared from
      // POLARIS_COMPONENTS, so the poison queue is named for the component —
      // and the two strings differ for webhook-sink, whose vendor is
      // `webhook`. That consumer asked the broker for `webhook.poison`, a
      // queue provisioning never declared, and died on boot while the other
      // four worked by coincidence. One call site is what stops that
      // recurring.
      poison: { component, producer },
      groupName,
      checkpoints,
    }),
    ownsConsumer: true,
  };
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
