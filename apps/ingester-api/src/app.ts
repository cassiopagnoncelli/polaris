import {
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type BootstrappedService,
  type OpenApiSetup,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";
import { closeDb, createDb, type Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";
import type { preHandlerAsyncHookHandler } from "fastify";

import {
  ApiKeyCache,
  createAuthPreHandler,
  createAuthService,
  createPostgresApiKeyRepository,
  type ApiKeyRepository,
} from "./auth/index.js";
import type { IngesterConfig } from "./config.js";
import { registerEventsRoutes } from "./routes/events.js";

/**
 * Options accepted by `buildIngesterApp`.
 *
 * The shell only required the loaded `IngesterConfig`; P2-002 adds optional
 * overrides for the auth layer so tests can drive the wiring without a live
 * PostgreSQL instance, and so future tasks can swap in a Redis-backed cache.
 */
export interface BuildIngesterAppOptions {
  /** Pre-loaded ingester runtime configuration. */
  readonly config: IngesterConfig;
  /**
   * Extra readiness probes plugged into `/ready`. The shell does not own
   * any concrete probes yet; P2-003 adds Redpanda and PostgreSQL
   * checks once those dependencies are wired in.
   */
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  /**
   * Optional OpenAPI integration hook. The shell defaults to a no-op so
   * the service runs in test/CI without `@fastify/swagger` etc.; P2-003
   * (or the dedicated OpenAPI task) wires in the Zod-typed generation.
   */
  readonly openApiSetup?: OpenApiSetup;
  /**
   * Additional shutdown tasks. The shell registers `closeDb` automatically
   * when it constructs the Kysely client itself; callers that pass in their
   * own DB instance own its lifecycle and may append more here.
   */
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  /**
   * Whether to install signal handlers. Defaults to `true` for the binary
   * entry point; tests pass `false` so `process.on(SIGTERM)` isn't polluted
   * across the Vitest worker.
   */
  readonly installShutdown?: boolean;
  /**
   * Override of `process.exit` for shutdown tests. Forwarded straight to the
   * shared bootstrap.
   */
  readonly shutdownExit?: (code: number) => void;
  /**
   * Pre-built Kysely client. When supplied, the app skips PostgreSQL pool
   * construction and does NOT register a `closeDb` shutdown task — the
   * caller owns the lifecycle. Tests use this to inject an in-memory fake
   * via the lower-level `apiKeyRepository` slot instead; production paths
   * leave it undefined so the app constructs (and owns) its own pool.
   */
  readonly db?: Kysely<Database>;
  /**
   * Pre-built API key repository. Takes precedence over `db`. Tests use this
   * to drive the auth flow without standing up Kysely.
   */
  readonly apiKeyRepository?: ApiKeyRepository;
}

/**
 * Build a fully wired Polaris ingester Fastify instance.
 *
 * The shell composes `bootstrapService` from
 * `@polaris/shared-service-bootstrap` so the service inherits:
 *
 *   - request-ID propagation
 *   - RFC 7807 Problem Details errors / 404 handler
 *   - `/health` and `/ready` routes
 *   - `/metrics` route stub
 *   - OpenAPI integration hook
 *   - graceful shutdown for SIGTERM/SIGINT
 *
 * On top of the shell, P2-002 wires:
 *
 *   - the typed Kysely client over PostgreSQL (via `@polaris/shared-db`)
 *   - the in-memory `ApiKeyCache` LRU/TTL
 *   - the auth service (parse -> lookup -> verify argon2id)
 *   - a Fastify `preHandler` hook on `POST /v1/events` that resolves the
 *     trusted `(project_id, environment, source)` tuple from the API key
 *     and stamps it on `request.auth`
 *
 * P2-003 will replace the 501 route body with the real batch handler; the
 * preHandler stays unchanged.
 */
export async function buildIngesterApp(
  options: BuildIngesterAppOptions,
): Promise<BootstrappedService> {
  const { config } = options;

  const ownedDb = options.db === undefined && options.apiKeyRepository === undefined;
  const db = options.db ?? (ownedDb ? buildDb(config) : undefined);

  const repository =
    options.apiKeyRepository ?? (db !== undefined ? createPostgresApiKeyRepository(db) : undefined);

  if (repository === undefined) {
    // The bootstrap accepts `apiKeyRepository` directly precisely so tests
    // can avoid constructing a DB. If neither is supplied here, the caller
    // misconfigured the app — fail fast with a precise message rather than
    // crash later inside the preHandler.
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

  // When we own the Kysely client we also own closing it on shutdown. We
  // prepend our own task so it runs before any caller-supplied task that
  // might depend on database access.
  const ownershipShutdownTasks: ShutdownTask[] = [];
  if (ownedDb && db !== undefined) {
    ownershipShutdownTasks.push(async () => {
      await closeDb(db);
    });
  }
  const shutdownTasks: ShutdownTask[] = [
    ...ownershipShutdownTasks,
    ...(options.shutdownTasks ?? []),
  ];

  const bootstrap = await bootstrapService({
    info: {
      serviceName: config.service.serviceName,
      serviceVersion: config.service.serviceVersion,
      environment: config.service.environment,
      ...(config.service.gitSha !== undefined ? { gitSha: config.service.gitSha } : {}),
      ...(config.service.buildTime !== undefined ? { buildTime: config.service.buildTime } : {}),
    },
    fastify: {
      bodyLimit: config.http.bodyLimitBytes,
      // Per-request log lines come from our own access-log line later;
      // suppress Fastify's default to keep JSON output deterministic.
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

  registerEventsRoutes(bootstrap.app, { authPreHandler });

  return bootstrap;
}

/**
 * Build a Kysely client from the parsed PostgreSQL config. Kept as a small
 * helper so the construction stays inline with `buildIngesterApp` for
 * readability while still being easy to swap during tests.
 */
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
