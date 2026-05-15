/**
 * Runtime configuration for the ga4 v1 destination consumer.
 *
 * Mirrors the tiktok v1 shape (`consumers/tiktok/v1/src/config.ts`):
 * service + http + redpanda + postgres + a small consumer-specific
 * block. Per-destination instance knobs (status, mode, max_rps,
 * retry_policy, dead_letter_threshold) live in the PostgreSQL
 * `destinations` row and are read at delivery time by the runtime;
 * this config only carries service-level toggles.
 *
 * Env var inventory (consumer-scoped):
 *
 *   POLARIS_GA4_CONSUMER_GROUP              KafkaJS consumer group identifier
 *                                           default: "polaris-ga4-v1"
 *   POLARIS_GA4_CONCURRENCY                 `partitionsConsumedConcurrently`
 *                                           default: 4
 *   POLARIS_GA4_REQUEST_TIMEOUT_MS          HTTP fetch timeout per attempt
 *                                           default: 5000 (per manifest)
 *   POLARIS_GA4_ALLOW_REPLAY                Toggle replay-suppression bypass
 *                                           default: false
 *   POLARIS_GA4_API_HOST                    GA4 Measurement Protocol host
 *                                           default: "www.google-analytics.com"
 */

import { z } from "zod";

import {
  booleanFromStringSchema,
  composeConfigSchema,
  httpEnvSchema,
  loadConfigWithDefaults,
  nonEmptyStringSchema,
  positiveIntSchema,
  postgresEnvSchema,
  redpandaEnvSchema,
  serviceEnvSchema,
  type HttpConfig,
  type PostgresConfig,
  type RedpandaConfig,
  type ServiceConfig,
} from "@polaris/shared-config";

/**
 * Default service name surfaced when `POLARIS_SERVICE_NAME` is omitted.
 * Matches the manifest `name` field.
 */
export const CONSUMER_SERVICE_NAME = "ga4" as const;

/**
 * Default GA4 Measurement Protocol host. Override via
 * `POLARIS_GA4_API_HOST` for test environments or debug endpoints
 * (`www.google-analytics.com` exposes `/debug/mp/collect` on the same
 * host with verbose validation responses; the host override is the
 * intended seam for swapping to staging endpoints in tests).
 */
export const DEFAULT_GA4_API_HOST = "www.google-analytics.com" as const;

/** Consumer-specific tuning knobs. */
export const ga4EnvSchema = z
  .object({
    POLARIS_GA4_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-ga4-v1"),
    POLARIS_GA4_CONCURRENCY: positiveIntSchema.default(4),
    POLARIS_GA4_REQUEST_TIMEOUT_MS: positiveIntSchema.default(5000),
    POLARIS_GA4_ALLOW_REPLAY: booleanFromStringSchema.default(false),
    POLARIS_GA4_API_HOST: nonEmptyStringSchema.default(DEFAULT_GA4_API_HOST),
  })
  .transform(
    (parsed): Ga4Config => ({
      consumerGroup: parsed["POLARIS_GA4_CONSUMER_GROUP"],
      partitionsConsumedConcurrently: parsed["POLARIS_GA4_CONCURRENCY"],
      requestTimeoutMs: parsed["POLARIS_GA4_REQUEST_TIMEOUT_MS"],
      allowReplay: parsed["POLARIS_GA4_ALLOW_REPLAY"],
      apiHost: parsed["POLARIS_GA4_API_HOST"],
    }),
  );

export interface Ga4Config {
  readonly consumerGroup: string;
  readonly partitionsConsumedConcurrently: number;
  readonly requestTimeoutMs: number;
  readonly allowReplay: boolean;
  readonly apiHost: string;
}

export const ga4EnvKeys = [
  "POLARIS_GA4_CONSUMER_GROUP",
  "POLARIS_GA4_CONCURRENCY",
  "POLARIS_GA4_REQUEST_TIMEOUT_MS",
  "POLARIS_GA4_ALLOW_REPLAY",
  "POLARIS_GA4_API_HOST",
] as const;

export interface Ga4RuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly redpanda: RedpandaConfig;
  readonly postgres: PostgresConfig;
  readonly ga4: Ga4Config;
}

export function ga4ConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    redpanda: redpandaEnvSchema,
    postgres: postgresEnvSchema,
    ga4: ga4EnvSchema,
  });
}

export function loadGa4Config(): Ga4RuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: CONSUMER_SERVICE_NAME,
    schema: ga4ConfigSchema(),
  });
}
