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
 *   POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP   ("polaris-attribution-engine-v1")
 *   POLARIS_ATTRIBUTION_ENGINE_CONCURRENCY      (1)
 *
 * These are NON-SEMANTIC operational settings per the architecture rule
 * (consumer group, concurrency). Semantic attribution rules (first-touch,
 * last-touch, delta detection) live in versioned code only and cannot be
 * tuned via env.
 */
export const attributionEngineEnvSchema = z
  .object({
    POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-attribution-engine-v1",
    ),
    POLARIS_ATTRIBUTION_ENGINE_CONCURRENCY: positiveIntSchema.default(1),
  })
  .transform(
    (parsed): AttributionEngineConfig => ({
      consumerGroup: parsed["POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP"],
      partitionsConsumedConcurrently: parsed["POLARIS_ATTRIBUTION_ENGINE_CONCURRENCY"],
    }),
  );

export interface AttributionEngineConfig {
  readonly consumerGroup: string;
  readonly partitionsConsumedConcurrently: number;
}

export const attributionEngineEnvKeys = [
  "POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP",
  "POLARIS_ATTRIBUTION_ENGINE_CONCURRENCY",
] as const;

/**
 * Full runtime configuration for the attribution-engine v1 service.
 */
export interface AttributionEngineRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly redpanda: RedpandaConfig;
  readonly attributionEngine: AttributionEngineConfig;
}

export function attributionEngineConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    redpanda: redpandaEnvSchema,
    attributionEngine: attributionEngineEnvSchema,
  });
}

export function loadAttributionEngineConfig(): AttributionEngineRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: attributionEngineConfigSchema(),
  });
}
