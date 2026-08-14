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
export const PROCESSOR_SERVICE_NAME = "attribution-engine" as const;

/**
 * Processor-specific tuning knobs.
 *
 * Env vars:
 *
 *   POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP   ("polaris-attribution-engine-v3")
 *
 * These are NON-SEMANTIC operational settings per the architecture rule
 * (consumer group, concurrency). Semantic attribution rules (first-touch,
 * last-touch, delta detection) live in versioned code only and cannot be
 * tuned via env.
 */
export const attributionEngineEnvSchema = z
  .object({
    POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-attribution-engine-v3",
    ),
  })
  .transform(
    (parsed): AttributionEngineConfig => ({
      consumerGroup: parsed["POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP"],
    }),
  );

export interface AttributionEngineConfig {
  readonly consumerGroup: string;
}

export const attributionEngineEnvKeys = ["POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP"] as const;

/**
 * Full runtime configuration for the attribution-engine v1 service.
 */
export interface AttributionEngineRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  /**
   * PostgreSQL connection. Required since the RabbitMQ migration: stream
   * consumers own their resume point (`transport_checkpoints`) because
   * AMQP has no server-side offset store.
   */
  readonly postgres: PostgresConfig;
  readonly rabbitmq: RabbitmqConfig;
  readonly attributionEngine: AttributionEngineConfig;
}

export function attributionEngineConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    postgres: postgresEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    attributionEngine: attributionEngineEnvSchema,
  });
}

export function loadAttributionEngineConfig(): AttributionEngineRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: attributionEngineConfigSchema(),
  });
}
