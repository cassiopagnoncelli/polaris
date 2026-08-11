import {
  composeConfigSchema,
  type HttpConfig,
  httpEnvSchema,
  loadConfigWithDefaults,
  nonEmptyStringSchema,
  type PostgresConfig,
  postgresEnvSchema,
  type RabbitmqConfig,
  rabbitmqEnvSchema,
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
 */
export const analyticsProjectorEnvSchema = z
  .object({
    POLARIS_ANALYTICS_PROJECTOR_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-analytics-projector-v1",
    ),
  })
  .transform(
    (parsed): AnalyticsProjectorConfig => ({
      consumerGroup: parsed["POLARIS_ANALYTICS_PROJECTOR_CONSUMER_GROUP"],
    }),
  );

export interface AnalyticsProjectorConfig {
  /**
   * Polaris consumer-group identifier: the namespace this processor's
   * stream checkpoints live under in `transport_checkpoints`. The default
   * matches the processor directory name + version so a v2 deployment
   * running in parallel keeps its own resume point (no offset bleed
   * between versions). Changing it rewinds the processor.
   */
  readonly consumerGroup: string;
}

export const analyticsProjectorEnvKeys = ["POLARIS_ANALYTICS_PROJECTOR_CONSUMER_GROUP"] as const;

/**
 * Full runtime configuration for the analytics-projector v1 service.
 *
 * Composed from the shared schema fragments so the deployment template
 * stays consistent with the ingester and the future production
 * processors (P8). Slots:
 *
 *   - service   — name, version, env, log level, build metadata
 *   - http      — host/port for /health, /ready, /metrics (no business routes)
 *   - rabbitmq  — connection URL, TLS, partitions, checkpoint cadence
 *   - projector — processor-specific knobs above
 */
export interface AnalyticsProjectorRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  /**
   * PostgreSQL connection. Required since the RabbitMQ migration: stream
   * consumers own their resume point (`transport_checkpoints`) because
   * AMQP has no server-side offset store.
   */
  readonly postgres: PostgresConfig;
  readonly rabbitmq: RabbitmqConfig;
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
    postgres: postgresEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
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
