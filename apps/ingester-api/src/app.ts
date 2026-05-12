import {
  bootstrapService,
  NOOP_OPENAPI_SETUP,
  type BootstrappedService,
  type OpenApiSetup,
  type ReadinessProbe,
  type ShutdownTask,
} from "@polaris/shared-service-bootstrap";

import type { IngesterConfig } from "./config.js";
import { registerEventsRoutes } from "./routes/events.js";

/**
 * Options accepted by `buildIngesterApp`.
 *
 * The shell only requires the loaded `IngesterConfig`; tests pass extra
 * overrides (synthetic readiness probes, alternate OpenAPI setups, ...) so
 * they exercise the wiring without spinning up real dependencies.
 */
export interface BuildIngesterAppOptions {
  /** Pre-loaded ingester runtime configuration. */
  readonly config: IngesterConfig;
  /**
   * Extra readiness probes plugged into `/ready`. The shell does not own
   * any concrete probes yet; P2-002/P2-003 add Redpanda and PostgreSQL
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
   * Additional shutdown tasks. The shell has none; later phases append
   * Kafka producer flush, PostgreSQL pool close, Redis client quit, etc.
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
 * The ingester adds its own routes on top — the shell only ships the
 * `POST /v1/events` stub (501 `not_implemented`) so SDK and integration
 * smoke tests have a stable URL while P2-002/P2-003 land.
 */
export async function buildIngesterApp(
  options: BuildIngesterAppOptions,
): Promise<BootstrappedService> {
  const { config } = options;

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
    ...(options.shutdownTasks !== undefined ? { shutdownTasks: options.shutdownTasks } : {}),
    installShutdown: options.installShutdown ?? true,
    ...(options.shutdownExit !== undefined ? { shutdownExit: options.shutdownExit } : {}),
  });

  registerEventsRoutes(bootstrap.app);

  return bootstrap;
}
