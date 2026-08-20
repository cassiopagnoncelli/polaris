/**
 * Runtime configuration for the tiktok v1 destination consumer.
 *
 * Mirrors the meta-capi v1 shape (`sync/destinations/meta-capi/v1/src/config.ts`):
 * service + http + rabbitmq + postgres + a small consumer-specific
 * block. Per-destination instance knobs (status, mode, max_rps,
 * retry_policy, dead_letter_threshold) live in the PostgreSQL
 * `destinations` row and are read at delivery time by the runtime;
 * this config only carries service-level toggles.
 *
 * Env var inventory (consumer-scoped):
 *
 *   POLARIS_TIKTOK_CONSUMER_GROUP           KafkaJS consumer group identifier
 *                                           default: "polaris-tiktok-v1"
 *                                           default: 4
 *   POLARIS_TIKTOK_REQUEST_TIMEOUT_MS       HTTP fetch timeout per attempt
 *                                           default: 5000 (per manifest)
 *   POLARIS_TIKTOK_ALLOW_REPLAY             Toggle replay-suppression bypass
 *                                           default: false
 *   POLARIS_TIKTOK_API_HOST                 TikTok Events API host
 *                                           default: "business-api.tiktok.com"
 */

import {
  booleanFromStringSchema,
  composeConfigSchema,
  type HttpConfig,
  httpEnvSchema,
  loadConfigWithDefaults,
  nonEmptyStringSchema,
  type PostgresConfig,
  positiveIntSchema,
  postgresEnvSchema,
  type RabbitmqConfig,
  type RedisConfig,
  rabbitmqEnvSchema,
  redisEnvSchema,
  type ServiceConfig,
  serviceEnvSchema,
} from "@polaris/runtime-config";
import { z } from "zod";

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
    POLARIS_TIKTOK_REQUEST_TIMEOUT_MS: positiveIntSchema.default(5000),
    POLARIS_TIKTOK_ALLOW_REPLAY: booleanFromStringSchema.default(false),
    POLARIS_TIKTOK_API_HOST: nonEmptyStringSchema.default(DEFAULT_TIKTOK_API_HOST),
  })
  .transform(
    (parsed): TikTokConfig => ({
      consumerGroup: parsed["POLARIS_TIKTOK_CONSUMER_GROUP"],
      requestTimeoutMs: parsed["POLARIS_TIKTOK_REQUEST_TIMEOUT_MS"],
      allowReplay: parsed["POLARIS_TIKTOK_ALLOW_REPLAY"],
      apiHost: parsed["POLARIS_TIKTOK_API_HOST"],
    }),
  );

export interface TikTokConfig {
  readonly consumerGroup: string;
  readonly requestTimeoutMs: number;
  readonly allowReplay: boolean;
  readonly apiHost: string;
}

export const tiktokEnvKeys = [
  "POLARIS_TIKTOK_CONSUMER_GROUP",
  "POLARIS_TIKTOK_REQUEST_TIMEOUT_MS",
  "POLARIS_TIKTOK_ALLOW_REPLAY",
  "POLARIS_TIKTOK_API_HOST",
] as const;

export interface TikTokRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly rabbitmq: RabbitmqConfig;
  readonly postgres: PostgresConfig;
  /**
   * Redis backs the multi-replica dedupe claim and the global RPS budget.
   *
   * Required configuration, like Postgres: without it two replicas can
   * double-send the same event and each allows the full `max_rps`, which
   * are the two defects those adapters exist to fix. A single-replica
   * deployment still needs a Redis to point at — running without one is not
   * a supported shape, it is the old bug with a shorter name.
   *
   * Redis being UNREACHABLE at runtime is different and is handled: both
   * adapters catch and degrade to their per-process implementations with a
   * warning, so a cache outage slows correctness guarantees rather than
   * halting delivery.
   */
  readonly redis: RedisConfig;
  readonly tiktok: TikTokConfig;
}

export function tiktokConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    redis: redisEnvSchema,
    tiktok: tiktokEnvSchema,
  });
}

export function loadTikTokConfig(): TikTokRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: CONSUMER_SERVICE_NAME,
    schema: tiktokConfigSchema(),
  });
}
