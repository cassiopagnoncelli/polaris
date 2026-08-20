import { createLogger, type Logger } from "@polaris/observability-logger";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import {
  createProblemErrorHandler,
  createProblemNotFoundHandler,
  type ProblemErrorHandlerOptions,
} from "./error-handler.js";
import {
  type HealthPluginOptions,
  type ReadinessProbe,
  registerHealthRoutes,
  type ServiceInfo,
} from "./health.js";
import {
  type MetricsPluginOptions,
  type MetricsProducer,
  registerMetricsRoute,
} from "./metrics.js";
import { NOOP_OPENAPI_SETUP, type OpenApiMetadata, type OpenApiSetup } from "./openapi.js";
import { genReqId, installRequestIdHook } from "./request-id-hook.js";
import {
  DEFAULT_SHUTDOWN_SIGNALS,
  type GracefulShutdownOptions,
  installGracefulShutdown,
  type ShutdownTask,
} from "./shutdown.js";

/**
 * Options accepted by `bootstrapService`. Most fields are optional so a
 * minimal service can call the bootstrap with just `info` and get a working
 * Fastify instance with request IDs, Problem Details errors, and
 * health/ready/metrics routes wired in.
 */
export interface BootstrapServiceOptions {
  /** Build/version metadata stamped on health responses and log bindings. */
  readonly info: ServiceInfo;
  /**
   * Optional pre-built logger. When omitted, `bootstrapService` creates one
   * with `service`, `version`, `env`, and `region` populated from `info`.
   */
  readonly logger?: Logger;
  /**
   * Forwarded into Fastify's constructor verbatim. `genReqId`, `loggerInstance`,
   * and `disableRequestLogging` are filled in by the bootstrap; callers can
   * override anything else (e.g. `bodyLimit`, `trustProxy`, `https`).
   */
  readonly fastify?: Omit<FastifyServerOptions, "genReqId" | "loggerInstance">;
  /**
   * Problem Details error handler overrides. Defaults are usually fine.
   */
  readonly problem?: ProblemErrorHandlerOptions;
  /** Readiness probes wired into `/ready`. */
  readonly readinessProbes?: ReadonlyArray<ReadinessProbe>;
  /** Health/readiness route options. */
  readonly health?: Pick<
    HealthPluginOptions,
    "healthPath" | "readinessPath" | "degradedIsNotReady"
  >;
  /** Metrics route options. The producer is plugged in by P10 metrics work. */
  readonly metrics?: MetricsPluginOptions;
  /** OpenAPI integration hook. Defaults to a no-op. */
  readonly openapi?: {
    readonly setup?: OpenApiSetup;
    readonly metadata?: OpenApiMetadata;
  };
  /** Whether to install graceful shutdown handlers. Defaults to `true`. */
  readonly installShutdown?: boolean;
  /** Extra cleanup tasks for graceful shutdown. */
  readonly shutdownTasks?: ReadonlyArray<ShutdownTask>;
  /** Override of `GracefulShutdownOptions.timeoutMs`. */
  readonly shutdownTimeoutMs?: number;
  /** Override the signal list (mostly useful in tests). */
  readonly shutdownSignals?: ReadonlyArray<NodeJS.Signals>;
  /** Override of `process.exit` for shutdown (mostly useful in tests). */
  readonly shutdownExit?: (code: number) => void;
}

/**
 * Outcome of a successful bootstrap call.
 */
export interface BootstrappedService {
  /** Configured Fastify instance, ready for `app.register(routes)`. */
  readonly app: FastifyInstance;
  /** Logger bound to the service identity. */
  readonly logger: Logger;
  /**
   * Trigger graceful shutdown manually. Resolves once Fastify and every
   * shutdown task have completed (or the hard timeout fires). When
   * `installShutdown` was false this is a no-op stub.
   */
  readonly shutdown: (signal?: NodeJS.Signals) => Promise<void>;
}

/**
 * Build a Fastify instance with the shared Polaris bootstrap.
 *
 * The returned instance has:
 *
 *   - a Pino logger from `@polaris/observability-logger` attached as
 *     `app.log` (and on every `request.log`)
 *   - per-request UUIDv7 IDs (echoed back as `x-request-id`)
 *   - RFC 7807 Problem Details error handler and 404 handler
 *   - `/health` and `/ready` routes returning JSON
 *   - `/metrics` route returning Prometheus text (empty by default)
 *   - OpenAPI integration hook invoked after route registration
 *   - graceful shutdown handlers for SIGTERM/SIGINT (opt-out)
 *
 * Routes and business logic are the service's responsibility; this helper
 * intentionally stays thin (per `09-engineering-standards.md` "Fastify
 * Service Structure").
 */
export async function bootstrapService(
  options: BootstrapServiceOptions,
): Promise<BootstrappedService> {
  const logger =
    options.logger ??
    createLogger({
      service: options.info.serviceName,
      version: options.info.serviceVersion,
      ...(options.info.environment !== undefined ? { env: options.info.environment } : {}),
      // Stamp the release label on the platform bindings so every log line
      // can be filtered by rollout in Loki/Grafana without each service
      // wiring it manually. The observability-logger schema reserves this key.
      ...(options.info.releaseLabel !== undefined
        ? { releaseLabel: options.info.releaseLabel }
        : {}),
    });

  const userFastify = options.fastify ?? {};
  // Pino's `Logger` is structurally compatible with Fastify's `FastifyBaseLogger`,
  // but TS's exactOptionalPropertyTypes path makes the inference too tight when
  // we let Fastify pick up the Pino-specific generic. We pin the FastifyInstance
  // generic to FastifyBaseLogger so route handlers, error handlers, and Fastify
  // child loggers stay assignable.
  const app: FastifyInstance = Fastify({
    ...userFastify,
    // We use the standard genReqId hook so caller-supplied IDs flow through
    // both routes and logger child scopes.
    genReqId,
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Fastify's own request-completion log adds noise to JSON logs; services
    // emit their own access-log style entries when needed.
    disableRequestLogging: userFastify.disableRequestLogging ?? true,
  });

  installRequestIdHook(app);

  app.setErrorHandler(createProblemErrorHandler(options.problem ?? {}));
  app.setNotFoundHandler(createProblemNotFoundHandler(options.problem ?? {}));

  registerHealthRoutes(app, {
    info: options.info,
    ...(options.readinessProbes !== undefined ? { probes: options.readinessProbes } : {}),
    ...(options.health?.healthPath !== undefined ? { healthPath: options.health.healthPath } : {}),
    ...(options.health?.readinessPath !== undefined
      ? { readinessPath: options.health.readinessPath }
      : {}),
    ...(options.health?.degradedIsNotReady !== undefined
      ? { degradedIsNotReady: options.health.degradedIsNotReady }
      : {}),
  });

  registerMetricsRoute(app, options.metrics ?? {});

  const openApiSetup = options.openapi?.setup ?? NOOP_OPENAPI_SETUP;
  const openApiMetadata = options.openapi?.metadata ?? {
    title: options.info.serviceName,
    version: options.info.serviceVersion,
  };
  await openApiSetup(app, openApiMetadata);

  let trigger: (signal: NodeJS.Signals) => Promise<void>;
  if (options.installShutdown ?? true) {
    const shutdownOpts: GracefulShutdownOptions = {
      app,
      logger,
      ...(options.shutdownTasks !== undefined ? { tasks: options.shutdownTasks } : {}),
      ...(options.shutdownTimeoutMs !== undefined ? { timeoutMs: options.shutdownTimeoutMs } : {}),
      ...(options.shutdownSignals !== undefined ? { signals: options.shutdownSignals } : {}),
      ...(options.shutdownExit !== undefined ? { exit: options.shutdownExit } : {}),
    };
    trigger = installGracefulShutdown(shutdownOpts);
  } else {
    trigger = async () => {
      /* no-op: shutdown not installed */
    };
  }

  return {
    app,
    logger,
    shutdown: async (signal = "SIGTERM") => trigger(signal),
  };
}

/**
 * Re-export `MetricsProducer` for caller convenience.
 */
export type { MetricsProducer };
/**
 * Re-export the default signal list so callers can compose their own
 * shutdown wiring without re-importing the underlying module.
 */
export { DEFAULT_SHUTDOWN_SIGNALS };
