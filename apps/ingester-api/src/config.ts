import { z } from "zod";

import {
  composeConfigSchema,
  durationMsSchema,
  httpEnvSchema,
  loadConfigWithDefaults,
  positiveIntSchema,
  postgresEnvSchema,
  serviceEnvSchema,
  type HttpConfig,
  type PostgresConfig,
  type ServiceConfig,
} from "@polaris/shared-config";

/**
 * Tuning knobs for the in-process API key cache.
 *
 * The cache backs `apps/ingester-api/src/auth/cache.ts`. Defaults are tuned
 * for a service running thousands of requests per second against a small key
 * population (tens of keys per project) — the cache largely keeps PostgreSQL
 * out of the hot path. Redis-backed caching is a future optimisation
 * (`docs/architecture/02-control-plane.md` "Redis Role").
 *
 * Env vars:
 *
 *   POLARIS_AUTH_CACHE_MAX_ENTRIES   (1024)
 *   POLARIS_AUTH_CACHE_TTL_MS        (60000)
 *   POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS (5000)
 */
export const authCacheEnvSchema = z
  .object({
    POLARIS_AUTH_CACHE_MAX_ENTRIES: positiveIntSchema.default(1024),
    POLARIS_AUTH_CACHE_TTL_MS: durationMsSchema.default(60_000),
    POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS: durationMsSchema.default(5_000),
  })
  .transform(
    (parsed): AuthCacheConfig => ({
      maxEntries: parsed["POLARIS_AUTH_CACHE_MAX_ENTRIES"],
      ttlMs: parsed["POLARIS_AUTH_CACHE_TTL_MS"],
      negativeTtlMs: parsed["POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS"],
    }),
  );

export interface AuthCacheConfig {
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly negativeTtlMs: number;
}

export const authCacheEnvKeys = [
  "POLARIS_AUTH_CACHE_MAX_ENTRIES",
  "POLARIS_AUTH_CACHE_TTL_MS",
  "POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS",
] as const;

/**
 * Runtime configuration for the Polaris ingester API.
 *
 * P2-002 attaches the PostgreSQL bindings and the API key cache tuning. The
 * shell shipped `service` + `http`; later tasks add Redpanda, Redis, and
 * forbidden-field policy switches as the ingester grows past the shell.
 *
 * @see docs/architecture/09-engineering-standards.md "Runtime Configuration"
 */
export interface IngesterConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly postgres: PostgresConfig;
  readonly authCache: AuthCacheConfig;
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
    postgres: postgresEnvSchema,
    authCache: authCacheEnvSchema,
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
