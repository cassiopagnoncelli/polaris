import {
  composeConfigSchema,
  httpEnvSchema,
  loadConfigWithDefaults,
  serviceEnvSchema,
  type HttpConfig,
  type ServiceConfig,
} from "@polaris/shared-config";

/**
 * Runtime configuration for the Polaris ingester API.
 *
 * The shell of the service only needs the standard service identity bindings
 * (name, version, environment, git SHA, ...) and Fastify HTTP server tuning.
 * Later tasks attach further sub-configs (Redpanda, Redis, PostgreSQL) as the
 * ingester grows past the shell.
 *
 * @see docs/architecture/09-engineering-standards.md "Runtime Configuration"
 */
export interface IngesterConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
}

/**
 * The default service name surfaced when `POLARIS_SERVICE_NAME` is not set.
 *
 * The shared config schema does require `POLARIS_SERVICE_NAME`, so this constant
 * is the value the ingester deployment templates should set. It is also used
 * by `loadIngesterConfig` so the `loadConfig` error message names the service
 * concretely on misconfiguration.
 */
export const INGESTER_SERVICE_NAME = "ingester-api" as const;

/**
 * Compose the ingester config schema from shared building blocks.
 *
 * Kept as a function so tests can rebuild the schema against synthetic env
 * sources without sharing a single Zod instance across runs.
 */
export function ingesterConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
  });
}

/**
 * Load the ingester runtime config, applying the shared `.env` precedence
 * rules. Throws `ConfigValidationError` (from `@polaris/shared-config`) when
 * any required value is missing or malformed; services let that error crash
 * the process so deployments fail fast.
 */
export function loadIngesterConfig(): IngesterConfig {
  return loadConfigWithDefaults({
    serviceName: INGESTER_SERVICE_NAME,
    schema: ingesterConfigSchema(),
  });
}
