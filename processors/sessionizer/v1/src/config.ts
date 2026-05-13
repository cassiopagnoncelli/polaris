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

import { DEFAULT_INACTIVITY_SECONDS } from "./transform.js";

/**
 * Default service name surfaced when `POLARIS_SERVICE_NAME` is omitted by
 * a deployment template. The shared config schema still requires the env
 * var, but this constant is what deployments are expected to set and what
 * the bootstrap reports through `/health`.
 */
export const PROCESSOR_SERVICE_NAME = "sessionizer" as const;

/**
 * Processor-specific tuning knobs.
 *
 * Env vars:
 *
 *   POLARIS_SESSIONIZER_CONSUMER_GROUP        ("polaris-sessionizer-v1")
 *   POLARIS_SESSIONIZER_CONCURRENCY           (1)
 *   POLARIS_SESSIONIZER_INACTIVITY_SECONDS    (1800)
 *
 * NOTE on `POLARIS_SESSIONIZER_INACTIVITY_SECONDS`: the inactivity window
 * is SEMANTIC per the processor manifest. Changing it would alter the
 * emitted `session.started` / `session.ended` events for the same input
 * slice. Operators may set this env var to mirror the manifest default
 * (1800) for transparency, but a real change requires a new processor
 * version (v2 directory + new manifest). The runtime defaults to the
 * manifest value and ignores attempts to widen it.
 */
export const sessionizerEnvSchema = z
  .object({
    POLARIS_SESSIONIZER_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-sessionizer-v1"),
    POLARIS_SESSIONIZER_CONCURRENCY: positiveIntSchema.default(1),
    POLARIS_SESSIONIZER_INACTIVITY_SECONDS: positiveIntSchema.default(DEFAULT_INACTIVITY_SECONDS),
  })
  .transform(
    (parsed): SessionizerConfig => ({
      consumerGroup: parsed["POLARIS_SESSIONIZER_CONSUMER_GROUP"],
      partitionsConsumedConcurrently: parsed["POLARIS_SESSIONIZER_CONCURRENCY"],
      inactivitySeconds: parsed["POLARIS_SESSIONIZER_INACTIVITY_SECONDS"],
    }),
  );

export interface SessionizerConfig {
  readonly consumerGroup: string;
  readonly partitionsConsumedConcurrently: number;
  readonly inactivitySeconds: number;
}

export const sessionizerEnvKeys = [
  "POLARIS_SESSIONIZER_CONSUMER_GROUP",
  "POLARIS_SESSIONIZER_CONCURRENCY",
  "POLARIS_SESSIONIZER_INACTIVITY_SECONDS",
] as const;

/**
 * Full runtime configuration for the sessionizer v1 service.
 */
export interface SessionizerRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly redpanda: RedpandaConfig;
  readonly sessionizer: SessionizerConfig;
}

export function sessionizerConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    redpanda: redpandaEnvSchema,
    sessionizer: sessionizerEnvSchema,
  });
}

export function loadSessionizerConfig(): SessionizerRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: sessionizerConfigSchema(),
  });
}
