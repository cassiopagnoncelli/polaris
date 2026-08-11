/**
 * Control-plane API service shell.
 *
 * Wires the shared `bootstrapService` (per-request UUIDv7 IDs, RFC 7807
 * Problem errors, /health, /ready, /metrics stub, graceful shutdown)
 * with the control-plane-specific preHandler chain:
 *
 *   1. Bearer-token authentication (`auth/bearer.ts`). Reads
 *      `Authorization: Bearer <token>`, resolves a `ResolvedActor`
 *      against the `OperatorTokenRepository`, and attaches it to
 *      `request.actor`.
 *
 *   2. Production-mutation gate (`auth/gate.ts`). On routes that
 *      declare `mutates: true`, refuses requests from
 *      `actor.source !== 'declared'` when the service runs against
 *      `POLARIS_ENV=production`. Returns RFC 7807 Problem with
 *      `code='production_requires_authenticated_actor'`.
 *
 * P6-000 ships only the smallest set of routes that prove the shell is
 * sound:
 *
 *   - `GET /v1/whoami` (non-mutating, auth-required)
 *   - `/health`, `/ready`, `/metrics` (from bootstrap)
 *   - `/openapi.json` (placeholder via the no-op OpenAPI setup; P6-002
 *     and later add the business routes that populate the document)
 *
 * Tests inject the `operatorTokenRepository` slot to drive auth
 * deterministically; production wires the Kysely-backed adapter from
 * `./operators/repository.ts`.
 */

import type { OperatorTokenRepository } from "@polaris/shared-control-plane";
import { closeDb, createDb, type Database } from "@polaris/shared-db";
import { createLogger } from "@polaris/shared-logger";
import { toPrometheusText } from "@polaris/shared-metrics";
import {
  type BootstrappedService,
  bootstrapService,
  type OpenApiSetup,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";
import type { Kysely } from "kysely";
import type { AdminMutations } from "./admin/actions/mutations.js";
import type { IdpAuth } from "./admin/idp-auth.js";
import type { IdpOAuthClient } from "./admin/idp-proxy.js";
import { registerAdminUi } from "./admin/index.js";
import type { AdminQueries } from "./admin/queries.js";
import type { SessionRefresher } from "./admin/refresh.js";
import { createBearerAuthPreHandler } from "./auth/bearer.js";
import type { ControlPlaneConfig } from "./config.js";
import { createPostgresReadinessProbe } from "./health/postgres-probe.js";
// In-process counter registry. Reuses the Polaris convention from the
// ingester (`IngestMetrics`); the control-plane v1 has no business
// counters yet, so the registry is empty. The bootstrap still serves
// `/metrics` with an empty Prometheus body so scrapers don't see 404s.
//
// We keep the structure here so a future P6-002+ task can land
// counters under a typed registry without re-wiring `/metrics`.
import { ControlPlaneMetrics } from "./metrics/registry.js";
import { controlPlaneOpenApiSetup } from "./openapi/setup.js";
import { createKyselyOperatorTokenRepository } from "./operators/repository.js";
import { registerWhoamiRoute } from "./routes/whoami.js";

export interface BuildControlPlaneAppOptions {
  readonly config: ControlPlaneConfig;
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  readonly openApiSetup?: OpenApiSetup;
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  readonly installShutdown?: boolean;
  readonly shutdownExit?: (code: number) => void;

  // ---- pluggable subsystem overrides ------------------------------------

  /** Pre-built Kysely client. When supplied, the app does NOT own its lifecycle. */
  readonly db?: Kysely<Database>;
  /**
   * Pre-built operator-token repository. Takes precedence over `db`.
   * Tests inject a stub; production builds the Kysely-backed adapter.
   */
  readonly operatorTokenRepository?: OperatorTokenRepository;
  /**
   * Hash-verifier override. Tests pass a stub so the suite does not
   * pay the argon2 cost.
   */
  readonly verifyHash?: (plaintext: string, hash: string, algorithm: string) => Promise<boolean>;
  /** Override `() => new Date()` for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Pre-built admin read queries. Tests inject fixtures so admin pages are
   * exercisable without a Postgres; production builds the Kysely-backed
   * implementation from `db`.
   */
  readonly adminQueries?: AdminQueries;
  /**
   * Pre-built Idp verification. Tests inject a stub so the suite needs
   * neither a live Idp nor a signing key.
   */
  readonly idpAuth?: IdpAuth;
  /**
   * Pre-built Idp OAuth client. Tests drive the authorization-code flow
   * without a live Idp.
   */
  readonly idpClient?: IdpOAuthClient;
  /**
   * Pre-built refresh-token redeemer. Tests exercise silent session refresh
   * without a live Idp.
   */
  readonly refresher?: SessionRefresher;
  /**
   * Audited admin writes. Built from `db` when omitted; pass `null` for an
   * explicitly read-only panel.
   */
  readonly adminMutations?: AdminMutations | null;
}

export async function buildControlPlaneApp(
  options: BuildControlPlaneAppOptions,
): Promise<BootstrappedService> {
  const { config } = options;

  const logger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
    ...(config.service.releaseLabel !== undefined
      ? { releaseLabel: config.service.releaseLabel }
      : {}),
  });

  // ---- DB + operator-token repository ----------------------------------
  const ownedDb = options.db === undefined && options.operatorTokenRepository === undefined;
  const db = options.db ?? (ownedDb ? buildDb(config) : undefined);
  const repository: OperatorTokenRepository =
    options.operatorTokenRepository ??
    (db !== undefined ? createKyselyOperatorTokenRepository(db) : undefinedRepoBug());

  // ---- preHandlers -----------------------------------------------------
  const authPreHandler = createBearerAuthPreHandler({
    repository,
    ...(options.verifyHash !== undefined ? { verify: options.verifyHash } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  // ---- metrics ---------------------------------------------------------
  const metrics = new ControlPlaneMetrics();

  // ---- readiness -------------------------------------------------------
  // Probe Postgres whenever we have a pool. Without this `/ready` returns 200
  // with a dead database — see health/postgres-probe.ts.
  const readinessProbes: ReadinessProbe[] = [];
  if (db !== undefined) readinessProbes.push(createPostgresReadinessProbe(db));
  if (options.readinessProbes !== undefined) readinessProbes.push(...options.readinessProbes);

  // ---- shutdown tasks --------------------------------------------------
  const shutdownTasks: ShutdownTask[] = [];
  if (ownedDb && db !== undefined) {
    shutdownTasks.push(async () => {
      try {
        await closeDb(db);
      } catch (err) {
        logger.warn({ err: errSummary(err) }, "postgres pool close error during shutdown");
      }
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
      ...(config.service.releaseLabel !== undefined
        ? { releaseLabel: config.service.releaseLabel }
        : {}),
    },
    logger,
    fastify: {
      bodyLimit: config.http.bodyLimitBytes,
      disableRequestLogging: true,
    },
    ...(readinessProbes.length > 0 ? { readinessProbes } : {}),
    openapi: {
      setup: options.openApiSetup ?? controlPlaneOpenApiSetup,
      metadata: {
        title: "Polaris Control-Plane API",
        version: config.service.serviceVersion,
        description:
          "HTTP control plane the polaris CLI fronts. Bearer-token authentication against operator_tokens, production-mutation gate, audit_records writes for every mutation.",
      },
    },
    ...(shutdownTasks.length > 0 ? { shutdownTasks } : {}),
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
    metrics: {
      producer: () => toPrometheusText(metrics.getSamples()),
    },
  });

  // ---- global auth hook -----------------------------------------------
  // The auth preHandler runs for EVERY route so `request.actor` is
  // always populated by the time route-specific preHandlers (the
  // mutation gate, business handlers) see the request. Health / ready /
  // metrics still work — the auth hook is non-blocking for absent
  // headers (collapses to `cli` source). A malformed bearer surfaces
  // as 401 even on a probe endpoint, which is the right posture (the
  // probe lies about its identity).
  bootstrap.app.addHook("preHandler", authPreHandler);

  // ---- routes ----------------------------------------------------------
  registerWhoamiRoute(bootstrap.app);

  // ---- admin UI --------------------------------------------------------
  // Registered last, always. It mounts as an encapsulated plugin under
  // /admin, so its cookie parser, form parser, HTML error handlers, and
  // session guard never reach /v1/* — the JSON API stays bearer-only and
  // cookie-blind, which is why it needs no CSRF story.
  await registerAdminUi(bootstrap.app, {
    config: config.admin,
    environment: config.service.environment,
    ...(db !== undefined ? { db } : {}),
    ...(options.adminQueries !== undefined ? { queries: options.adminQueries } : {}),
    ...(options.idpAuth !== undefined ? { idpAuth: options.idpAuth } : {}),
    ...(options.idpClient !== undefined ? { idpClient: options.idpClient } : {}),
    ...(options.refresher !== undefined ? { refresher: options.refresher } : {}),
    ...(options.adminMutations !== undefined ? { mutations: options.adminMutations } : {}),
  });

  return bootstrap;
}

function buildDb(config: ControlPlaneConfig): Kysely<Database> {
  const pg = config.postgres;
  const params = new URLSearchParams();
  params.set("sslmode", pg.ssl ? "require" : "disable");
  const connectionString = `postgres://${encodeURIComponent(pg.user)}:${encodeURIComponent(pg.password)}@${pg.host}:${pg.port}/${pg.database}?${params.toString()}`;
  return createDb({ connectionString, maxConnections: pg.poolMax });
}

function undefinedRepoBug(): never {
  throw new Error(
    "buildControlPlaneApp: pass `db`, `operatorTokenRepository`, or leave both undefined to construct from config.postgres.",
  );
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
