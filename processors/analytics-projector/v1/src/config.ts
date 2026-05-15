import {
  composeConfigSchema,
  type HttpConfig,
  httpEnvSchema,
  loadConfigWithDefaults,
  nonEmptyStringSchema,
  positiveIntSchema,
  type RedpandaConfig,
  redpandaEnvSchema,
  type ServiceConfig,
  serviceEnvSchema,
} from "@polaris/shared-config";
import { z } from "zod";

/**
 * Default service name surfaced when `POLARIS_SERVICE_NAME` is omitted by
 * a deployment template. The shared config schema still requires the env
 * var, but this constant is what deployments are expected to set and what
 * the bootstrap reports through `/health`.
 */
export const PROCESSOR_SERVICE_NAME = "analytics-projector" as const;

/**
 * Processor-specific tuning knobs.
 *
 * v1 ships with a single consumer group and no per-project activation —
 * the processor consumes all of `raw.events`. Per-project enable/disable
 * is wired by P6-005 against the PostgreSQL activation table. Until then,
 * deployments tune behaviour exclusively through these env vars.
 *
 * Env vars:
 *
 *   POLARIS_ANALYTICS_PROJECTOR_CONSUMER_GROUP         ("polaris-analytics-projector-v1")
 *   POLARIS_ANALYTICS_PROJECTOR_CONCURRENCY            (1)
 */
export const analyticsProjectorEnvSchema = z
  .object({
    POLARIS_ANALYTICS_PROJECTOR_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-analytics-projector-v1",
    ),
    POLARIS_ANALYTICS_PROJECTOR_CONCURRENCY: positiveIntSchema.default(1),
  })
  .transform(
    (parsed): AnalyticsProjectorConfig => ({
      consumerGroup: parsed["POLARIS_ANALYTICS_PROJECTOR_CONSUMER_GROUP"],
      partitionsConsumedConcurrently: parsed["POLARIS_ANALYTICS_PROJECTOR_CONCURRENCY"],
    }),
  );

export interface AnalyticsProjectorConfig {
  /**
   * KafkaJS consumer group identifier. The default matches the processor
   * directory name + version so multiple replicas of the same processor
   * version cooperate, and a v2 deployment running in parallel uses a
   * different group (no offset bleed between versions).
   */
  readonly consumerGroup: string;
  /**
   * Max partitions a single KafkaJS consumer instance reads in parallel.
   * Defaults to 1 — the skeleton is single-threaded per process. P8
   * processors with heavier transforms may tune this up.
   */
  readonly partitionsConsumedConcurrently: number;
}

export const analyticsProjectorEnvKeys = [
  "POLARIS_ANALYTICS_PROJECTOR_CONSUMER_GROUP",
  "POLARIS_ANALYTICS_PROJECTOR_CONCURRENCY",
] as const;

/**
 * Full runtime configuration for the analytics-projector v1 service.
 *
 * Composed from the shared schema fragments so the deployment template
 * stays consistent with the ingester and the future production
 * processors (P8). Slots:
 *
 *   - service   — name, version, env, log level, build metadata
 *   - http      — host/port for /health, /ready, /metrics (no business routes)
 *   - redpanda  — broker list, SSL, SASL, timeouts
 *   - projector — processor-specific knobs above
 */
export interface AnalyticsProjectorRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly redpanda: RedpandaConfig;
  readonly projector: AnalyticsProjectorConfig;
}

/**
 * Compose the runtime config schema. Kept as a function so test runs can
 * rebuild the schema against synthetic env sources without sharing a single
 * Zod instance (matches the ingester pattern).
 */
export function analyticsProjectorConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    redpanda: redpandaEnvSchema,
    projector: analyticsProjectorEnvSchema,
  });
}

/**
 * Load the runtime config. Throws `ConfigValidationError` (from
 * `@polaris/shared-config`) when any required value is missing or
 * malformed — services let that error crash the process so deployments
 * fail fast.
 */
export function loadAnalyticsProjectorConfig(): AnalyticsProjectorRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: analyticsProjectorConfigSchema(),
  });
}
