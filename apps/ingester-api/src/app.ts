import type { preHandlerAsyncHookHandler } from "fastify";
import type { Kysely } from "kysely";

import { closeDb, createDb, type Database } from "@polaris/shared-db";
import {
  createKafkaClient,
  createPolarisProducer,
  type PolarisProducer,
} from "@polaris/shared-kafka";
import { createLogger, type Logger } from "@polaris/shared-logger";
import type { ProjectPolicyOverride } from "@polaris/shared-policy";
import type { EventCatalog } from "@polaris/shared-schemas";
import {
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type BootstrappedService,
  type OpenApiSetup,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";

import {
  ApiKeyCache,
  createAuthPreHandler,
  createAuthService,
  createPostgresApiKeyRepository,
  type ApiKeyRepository,
} from "./auth/index.js";
import { loadRuntimeCatalog } from "./catalog/runtime.js";
import type { IngesterConfig } from "./config.js";
import {
  DisabledDedupeStore,
  createRedisDedupeStore,
  type DedupeStore,
  type RedisClientLike,
} from "./dedupe/index.js";
import { buildRedisOptions } from "./dedupe/redis.js";
import { createIngestHandler, type IngestHandler } from "./ingest/handler.js";
import { IngestMetrics } from "./metrics/registry.js";
import { createPolicyResolver, type PolicyResolver } from "./policy/loader.js";
import { registerEventsRoutes } from "./routes/events.js";

/**
 * Options accepted by `buildIngesterApp`.
 *
 * Most slots are optional and default to production wiring. Tests override
 * `apiKeyRepository`, `producer`, `dedupe`, and `catalog` to avoid bringing
 * up PostgreSQL, Redis, Redpanda, and the YAML catalog tree.
 */
export interface BuildIngesterAppOptions {
  /** Pre-loaded ingester runtime configuration. */
  readonly config: IngesterConfig;
  /** Extra readiness probes plugged into `/ready`. */
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  /** Optional OpenAPI integration hook. Defaults to no-op. */
  readonly openApiSetup?: OpenApiSetup;
  /** Additional shutdown tasks. */
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  /** Whether to install signal handlers. */
  readonly installShutdown?: boolean;
  /** Override of `process.exit` for shutdown tests. */
  readonly shutdownExit?: (code: number) => void;

  // ---- pluggable subsystem overrides ------------------------------------

  /** Pre-built Kysely client. When supplied, the app does NOT own its lifecycle. */
  readonly db?: Kysely<Database>;
  /** Pre-built API key repository. Takes precedence over `db`. */
  readonly apiKeyRepository?: ApiKeyRepository;
  /**
   * Pre-built Polaris producer. When supplied, the app does NOT call
   * `connect()` or `disconnect()`; the caller owns the lifecycle. Tests use
   * this slot to inject an in-memory fake.
   */
  readonly producer?: PolarisProducer;
  /**
   * Pre-built dedupe store. When supplied, the app does NOT construct a
   * Redis client. Tests use this slot to inject `InMemoryDedupeStore` or a
   * fake.
   */
  readonly dedupe?: DedupeStore;
  /**
   * Pre-loaded event catalog. When supplied, the app skips the on-disk
   * YAML loader.
   */
  readonly catalog?: EventCatalog;
  /**
   * Map of project_id -> policy override. Populates the policy resolver.
   * Production builds populate this from `catalog/policy/forbidden-fields.*.ts`
   * at deploy time (a future task; v1 ships the resolver with the empty
   * map, which means every project uses platform defaults).
   */
  readonly projectPolicies?: ReadonlyMap<string, ProjectPolicyOverride>;
  /** Pre-built ingest metrics registry — useful for sharing with `/metrics`. */
  readonly metrics?: IngestMetrics;
  /**
   * Optional Redis client. Tests inject a fake; production hosts let the
   * app construct an `ioredis` client from `config.redis`.
   */
  readonly redisClient?: RedisClientLike;
}

/**
 * Build a fully wired Polaris ingester Fastify instance.
 *
 * Wired by this function:
 *
 *   - request-ID propagation, RFC 7807 errors, `/health`, `/ready`,
 *     `/metrics` stub, OpenAPI hook, graceful shutdown (from
 *     `@polaris/shared-service-bootstrap`).
 *   - Typed Kysely client over PostgreSQL (via `@polaris/shared-db`).
 *   - In-memory `ApiKeyCache` LRU/TTL + auth service + Fastify preHandler.
 *   - Event catalog (loaded from `catalog/events/**` once at startup).
 *   - Forbidden-field policy resolver (platform defaults plus optional
 *     per-project overrides).
 *   - Redpanda producer through `@polaris/shared-kafka`.
 *   - Redis dedupe store (with documented fall-back behaviour).
 *   - The real `POST /v1/events` handler (replaces the 501 stub).
 *
 * The function is intentionally large so the wiring is in one place; the
 * subsystem-level overrides above keep tests scoped.
 */
export async function buildIngesterApp(
  options: BuildIngesterAppOptions,
): Promise<BootstrappedService> {
  const { config } = options;

  // Build the logger up front so each subsystem (producer, dedupe) shares
  // the same Pino instance. The bootstrap reuses it on the way in.
  const logger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
  });

  // ---- DB + API key repository -----------------------------------------
  const ownedDb = options.db === undefined && options.apiKeyRepository === undefined;
  const db = options.db ?? (ownedDb ? buildDb(config) : undefined);
  const repository =
    options.apiKeyRepository ?? (db !== undefined ? createPostgresApiKeyRepository(db) : undefined);
  if (repository === undefined) {
    throw new Error(
      "buildIngesterApp: pass `db`, `apiKeyRepository`, or leave both undefined to construct from config.postgres.",
    );
  }
  const cache = new ApiKeyCache({
    repository,
    maxEntries: config.authCache.maxEntries,
    ttlMs: config.authCache.ttlMs,
    negativeTtlMs: config.authCache.negativeTtlMs,
  });
  const authenticate = createAuthService({ repository: cache });
  const authPreHandler: preHandlerAsyncHookHandler = createAuthPreHandler({ authenticate });

  // ---- catalog + policy ------------------------------------------------
  const catalog = options.catalog ?? loadRuntimeCatalog();
  const policy: PolicyResolver = createPolicyResolver({
    ...(options.projectPolicies !== undefined ? { projectPolicies: options.projectPolicies } : {}),
  });

  // ---- metrics ---------------------------------------------------------
  const metrics = options.metrics ?? new IngestMetrics();

  // ---- producer --------------------------------------------------------
  const { producer, ownedProducer } = buildProducer(config, options.producer, logger);
  if (ownedProducer) {
    try {
      await producer.connect();
    } catch (err) {
      logger.error(
        { component: "ingest.producer", err: errSummary(err) },
        "raw.events producer failed to connect",
      );
      // We do NOT throw here — `/ready` will report the producer as down so
      // orchestrators can pull traffic without the service crashing. The
      // first request that tries to publish will surface the upstream error
      // through the per-event `publish_failed` reason code.
    }
  }

  // ---- dedupe ----------------------------------------------------------
  const { dedupe, ownedDedupe } = await buildDedupeStore(config, options, logger);

  // ---- consolidate shutdown tasks --------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  if (ownedDb && db !== undefined) {
    shutdownTasks.push(async () => {
      await closeDb(db);
    });
  }
  if (ownedProducer) {
    shutdownTasks.push(async () => {
      try {
        await producer.disconnect();
      } catch (err) {
        logger.warn(
          { component: "ingest.producer", err: errSummary(err) },
          "producer disconnect error during shutdown",
        );
      }
    });
  }
  if (ownedDedupe && dedupe.close !== undefined) {
    const closeFn = dedupe.close.bind(dedupe);
    shutdownTasks.push(async () => {
      await closeFn();
    });
  }
  if (options.shutdownTasks !== undefined) {
    shutdownTasks.push(...options.shutdownTasks);
  }

  // ---- bootstrap (Fastify + observability shell) ----------------------
  const bootstrap = await bootstrapService({
    info: {
      serviceName: config.service.serviceName,
      serviceVersion: config.service.serviceVersion,
      environment: config.service.environment,
      ...(config.service.gitSha !== undefined ? { gitSha: config.service.gitSha } : {}),
      ...(config.service.buildTime !== undefined ? { buildTime: config.service.buildTime } : {}),
    },
    logger,
    fastify: {
      bodyLimit: config.http.bodyLimitBytes,
      disableRequestLogging: true,
    },
    ...(options.readinessProbes !== undefined ? { readinessProbes: options.readinessProbes } : {}),
    openapi: {
      setup: options.openApiSetup ?? NOOP_OPENAPI_SETUP,
      metadata: {
        title: "Polaris Ingester API",
        version: config.service.serviceVersion,
        description:
          "Event ingestion API for Polaris SDKs and trusted producers. Authenticates API keys, validates events against the catalog, applies the forbidden-field policy, and publishes accepted events to Redpanda.",
      },
    },
    ...(shutdownTasks.length > 0 ? { shutdownTasks } : {}),
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
  });

  // ---- ingest handler + route -----------------------------------------
  const handler: IngestHandler = createIngestHandler({
    catalog,
    policy,
    producer,
    dedupe,
    metrics,
    logger,
    ingestConfig: config.ingest,
  });

  registerEventsRoutes(bootstrap.app, { authPreHandler, handler });

  return bootstrap;
}

function buildDb(config: IngesterConfig): Kysely<Database> {
  const params = new URLSearchParams();
  params.set("sslmode", config.postgres.ssl ? "require" : "disable");
  const connectionString = `postgres://${encodeURIComponent(config.postgres.user)}:${encodeURIComponent(
    config.postgres.password,
  )}@${config.postgres.host}:${config.postgres.port}/${config.postgres.database}?${params.toString()}`;
  return createDb({
    connectionString,
    maxConnections: config.postgres.poolMax,
  });
}

function buildProducer(
  config: IngesterConfig,
  override: PolarisProducer | undefined,
  logger: Logger,
): { producer: PolarisProducer; ownedProducer: boolean } {
  if (override !== undefined) {
    return { producer: override, ownedProducer: false };
  }
  const kafka = createKafkaClient({ redpanda: config.redpanda });
  const producer = createPolarisProducer({
    kafka,
    logger,
    producerName: config.service.serviceName,
    producerVersion: config.service.serviceVersion,
  });
  return { producer, ownedProducer: true };
}

async function buildDedupeStore(
  config: IngesterConfig,
  options: BuildIngesterAppOptions,
  logger: Logger,
): Promise<{ dedupe: DedupeStore; ownedDedupe: boolean }> {
  if (options.dedupe !== undefined) {
    return { dedupe: options.dedupe, ownedDedupe: false };
  }
  const client = options.redisClient ?? (await maybeBuildRedisClient(config, logger));
  if (client === undefined) {
    // No Redis client and no override — operate in the documented
    // "Redis unavailable, do not dedupe at all" mode. The handler still
    // calls `claim()` per event, which yields `skipped`, the dedupe-skipped
    // metric increments, and the event continues. Downstream consumers
    // remain canonically idempotent.
    logger.warn(
      { component: "ingest.dedupe" },
      "no Redis client configured for ingester dedupe; running in dedupe-disabled mode",
    );
    return { dedupe: new DisabledDedupeStore(), ownedDedupe: false };
  }
  const dedupe = createRedisDedupeStore({
    client,
    keyPrefix: config.ingest.redisKeyPrefix,
    opTimeoutMs: config.ingest.redisOpTimeoutMs,
    logger,
  });
  return { dedupe, ownedDedupe: true };
}

async function maybeBuildRedisClient(
  config: IngesterConfig,
  logger: Logger,
): Promise<RedisClientLike | undefined> {
  try {
    // Dynamic import keeps tests (which inject `dedupe`) from pulling in
    // ioredis. We cast through `unknown` because the ioredis module record
    // shape is wider than the structural `RedisClientLike` we model — the
    // narrow shape is intentional so future swaps (node-redis, ValKey)
    // stay drop-in.
    const ioredisModule = (await import("ioredis")) as unknown as {
      readonly default?: new (options: ReturnType<typeof buildRedisOptions>) => RedisClientLike;
    };
    const IoRedisCtor = ioredisModule.default;
    if (typeof IoRedisCtor !== "function") {
      logger.warn(
        { component: "ingest.dedupe" },
        "ioredis module does not expose a default-exported constructor; dedupe disabled",
      );
      return undefined;
    }
    const options = buildRedisOptions(config.redis);
    const client = new IoRedisCtor(options);
    return client;
  } catch (err) {
    logger.warn(
      { component: "ingest.dedupe", err: errSummary(err) },
      "ioredis is not installed; running ingester in dedupe-disabled mode",
    );
    return undefined;
  }
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
