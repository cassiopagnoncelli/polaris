/**
 * Runtime configuration for the identity-resolver v1 processor.
 *
 * Mirrors the sessionizer / analytics-projector pattern: a small Zod
 * schema composing shared-config building blocks with a per-service
 * block. The processor consumes `raw.events`, writes to
 * `identity_links`, and emits canonical identity events on
 * `identity.events`.
 */

import {
  composeConfigSchema,
  type HttpConfig,
  httpEnvSchema,
  loadConfigWithDefaults,
  nonEmptyStringSchema,
  type PostgresConfig,
  positiveIntSchema,
  postgresEnvSchema,
  type RedpandaConfig,
  redpandaEnvSchema,
  type ServiceConfig,
  serviceEnvSchema,
} from "@polaris/shared-config";
import { z } from "zod";

/** Default service name surfaced when `POLARIS_SERVICE_NAME` is omitted. */
export const PROCESSOR_SERVICE_NAME = "identity-resolver" as const;

/**
 * Processor-specific tuning knobs. Env vars:
 *
 *   POLARIS_IDENTITY_RESOLVER_CONSUMER_GROUP   ("polaris-identity-resolver-v1")
 *   POLARIS_IDENTITY_RESOLVER_CONCURRENCY      (1)
 */
export const identityResolverEnvSchema = z
  .object({
    POLARIS_IDENTITY_RESOLVER_CONSUMER_GROUP: nonEmptyStringSchema.default(
      "polaris-identity-resolver-v1",
    ),
    POLARIS_IDENTITY_RESOLVER_CONCURRENCY: positiveIntSchema.default(1),
  })
  .transform(
    (parsed): IdentityResolverConfig => ({
      consumerGroup: parsed["POLARIS_IDENTITY_RESOLVER_CONSUMER_GROUP"],
      partitionsConsumedConcurrently: parsed["POLARIS_IDENTITY_RESOLVER_CONCURRENCY"],
    }),
  );

export interface IdentityResolverConfig {
  readonly consumerGroup: string;
  readonly partitionsConsumedConcurrently: number;
}

export const identityResolverEnvKeys = [
  "POLARIS_IDENTITY_RESOLVER_CONSUMER_GROUP",
  "POLARIS_IDENTITY_RESOLVER_CONCURRENCY",
] as const;

/**
 * Full runtime config: service / http / redpanda / postgres / resolver.
 */
export interface IdentityResolverRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly redpanda: RedpandaConfig;
  readonly postgres: PostgresConfig;
  readonly resolver: IdentityResolverConfig;
}

export function identityResolverConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    redpanda: redpandaEnvSchema,
    postgres: postgresEnvSchema,
    resolver: identityResolverEnvSchema,
  });
}

export function loadIdentityResolverConfig(): IdentityResolverRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: identityResolverConfigSchema(),
  });
}
