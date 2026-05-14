/**
 * Runtime configuration for the tiktok v1 destination consumer.
 *
 * Mirrors the meta-capi v1 shape (`consumers/meta-capi/v1/src/config.ts`):
 * service + http + redpanda + postgres + a small consumer-specific
 * block. Per-destination instance knobs (status, mode, max_rps,
 * retry_policy, dead_letter_threshold) live in the PostgreSQL
 * `destinations` row and are read at delivery time by the runtime;
 * this config only carries service-level toggles.
 *
 * Env var inventory (consumer-scoped):
 *
 *   POLARIS_TIKTOK_CONSUMER_GROUP           KafkaJS consumer group identifier
 *                                           default: "polaris-tiktok-v1"
 *   POLARIS_TIKTOK_CONCURRENCY              `partitionsConsumedConcurrently`
 *                                           default: 4
 *   POLARIS_TIKTOK_REQUEST_TIMEOUT_MS       HTTP fetch timeout per attempt
 *                                           default: 5000 (per manifest)
 *   POLARIS_TIKTOK_ALLOW_REPLAY             Toggle replay-suppression bypass
 *                                           default: false
 *   POLARIS_TIKTOK_API_HOST                 TikTok Events API host
 *                                           default: "business-api.tiktok.com"
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
export const CONSUMER_SERVICE_NAME = "tiktok" as const;

/**
 * Default TikTok Events API host. Override via `POLARIS_TIKTOK_API_HOST`
 * for test environments or sandbox endpoints.
 */
export const DEFAULT_TIKTOK_API_HOST = "business-api.tiktok.com" as const;

/** Consumer-specific tuning knobs. */
export const tiktokEnvSchema = z
  .object({
    POLARIS_TIKTOK_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-tiktok-v1"),
    POLARIS_TIKTOK_CONCURRENCY: positiveIntSchema.default(4),
    POLARIS_TIKTOK_REQUEST_TIMEOUT_MS: positiveIntSchema.default(5000),
    POLARIS_TIKTOK_ALLOW_REPLAY: booleanFromStringSchema.default(false),
    POLARIS_TIKTOK_API_HOST: nonEmptyStringSchema.default(DEFAULT_TIKTOK_API_HOST),
  })
  .transform(
    (parsed): TikTokConfig => ({
      consumerGroup: parsed["POLARIS_TIKTOK_CONSUMER_GROUP"],
      partitionsConsumedConcurrently: parsed["POLARIS_TIKTOK_CONCURRENCY"],
      requestTimeoutMs: parsed["POLARIS_TIKTOK_REQUEST_TIMEOUT_MS"],
      allowReplay: parsed["POLARIS_TIKTOK_ALLOW_REPLAY"],
      apiHost: parsed["POLARIS_TIKTOK_API_HOST"],
    }),
  );

export interface TikTokConfig {
  readonly consumerGroup: string;
  readonly partitionsConsumedConcurrently: number;
  readonly requestTimeoutMs: number;
  readonly allowReplay: boolean;
  readonly apiHost: string;
}

export const tiktokEnvKeys = [
  "POLARIS_TIKTOK_CONSUMER_GROUP",
  "POLARIS_TIKTOK_CONCURRENCY",
  "POLARIS_TIKTOK_REQUEST_TIMEOUT_MS",
  "POLARIS_TIKTOK_ALLOW_REPLAY",
  "POLARIS_TIKTOK_API_HOST",
] as const;

export interface TikTokRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly redpanda: RedpandaConfig;
  readonly postgres: PostgresConfig;
  readonly tiktok: TikTokConfig;
}

export function tiktokConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    redpanda: redpandaEnvSchema,
    postgres: postgresEnvSchema,
    tiktok: tiktokEnvSchema,
  });
}

export function loadTikTokConfig(): TikTokRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: CONSUMER_SERVICE_NAME,
    schema: tiktokConfigSchema(),
  });
}
