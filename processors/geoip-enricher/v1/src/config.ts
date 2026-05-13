import { z } from "zod";

import {
  composeConfigSchema,
  httpEnvSchema,
  loadConfigWithDefaults,
  nonEmptyStringSchema,
  positiveIntSchema,
  redpandaEnvSchema,
  serviceEnvSchema,
  type HttpConfig,
  type RedpandaConfig,
  type ServiceConfig,
} from "@polaris/shared-config";

/**
 * Default service name surfaced when `POLARIS_SERVICE_NAME` is omitted
 * by a deployment template. The shared config schema still requires the
 * env var, but this constant is what deployments are expected to set
 * and what the bootstrap reports through `/health`.
 */
export const PROCESSOR_SERVICE_NAME = "geoip-enricher" as const;

/**
 * Processor-specific tuning knobs.
 *
 * v1 ships with a single consumer group and no per-project activation —
 * the processor consumes all of `raw.events`. Per-project enable/disable
 * is wired by P6-005 against the PostgreSQL activation table. Until
 * then, deployments tune behaviour exclusively through these env vars.
 *
 * Env vars:
 *
 *   POLARIS_GEOIP_ENRICHER_CONSUMER_GROUP   ("polaris-geoip-enricher-v1")
 *   POLARIS_GEOIP_ENRICHER_CONCURRENCY      (1)
 *
 * The MaxMind database path env var (`POLARIS_GEOIP_DB_PATH`) is NOT
 * read in v1 because the MaxMind backend is out of scope. The follow-up
 * task that adds the MaxMind adapter will introduce that env var here.
 */
export const geoipEnricherEnvSchema = z
  .object({
    POLARIS_GEOIP_ENRICHER_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-geoip-enricher-v1",
    ),
    POLARIS_GEOIP_ENRICHER_CONCURRENCY: positiveIntSchema.default(1),
  })
  .transform(
    (parsed): GeoipEnricherConfig => ({
      consumerGroup: parsed["POLARIS_GEOIP_ENRICHER_CONSUMER_GROUP"],
      partitionsConsumedConcurrently: parsed["POLARIS_GEOIP_ENRICHER_CONCURRENCY"],
    }),
  );

export interface GeoipEnricherConfig {
  /**
   * KafkaJS consumer group identifier. The default matches the
   * processor directory name + version so multiple replicas cooperate
   * and a v2 deployment running in parallel uses a different group (no
   * offset bleed between versions).
   */
  readonly consumerGroup: string;
  /**
   * Max partitions a single KafkaJS consumer instance reads in
   * parallel. Defaults to 1 — the skeleton is single-threaded per
   * process. Heavier enrichment backends (the future MaxMind adapter)
   * may tune this up.
   */
  readonly partitionsConsumedConcurrently: number;
}

export const geoipEnricherEnvKeys = [
  "POLARIS_GEOIP_ENRICHER_CONSUMER_GROUP",
  "POLARIS_GEOIP_ENRICHER_CONCURRENCY",
] as const;

/**
 * Full runtime configuration for the geoip-enricher v1 service.
 *
 * Composed from the shared schema fragments so the deployment template
 * stays consistent with the ingester and the analytics-projector.
 * Slots:
 *
 *   - service   — name, version, env, log level, build metadata
 *   - http      — host/port for /health, /ready, /metrics
 *   - redpanda  — broker list, SSL, SASL, timeouts
 *   - enricher  — processor-specific knobs above
 */
export interface GeoipEnricherRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly redpanda: RedpandaConfig;
  readonly enricher: GeoipEnricherConfig;
}

/**
 * Compose the runtime config schema. Kept as a function so test runs
 * can rebuild the schema against synthetic env sources without sharing
 * a single Zod instance (matches the analytics-projector pattern).
 */
export function geoipEnricherConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    redpanda: redpandaEnvSchema,
    enricher: geoipEnricherEnvSchema,
  });
}

/**
 * Load the runtime config. Throws `ConfigValidationError` (from
 * `@polaris/shared-config`) when any required value is missing or
 * malformed — services let that error crash the process so deployments
 * fail fast.
 */
export function loadGeoipEnricherConfig(): GeoipEnricherRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: geoipEnricherConfigSchema(),
  });
}
