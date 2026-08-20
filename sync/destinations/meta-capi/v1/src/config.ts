/**
 * Runtime configuration for the meta-capi v1 destination consumer.
 *
 * Mirrors the webhook-sink v1 shape (`sync/destinations/webhook-sink/v1/src/
 * config.ts`): service + http + rabbitmq + postgres + a small
 * consumer-specific block. Per-destination instance knobs (status,
 * mode, max_rps, retry_policy, dead_letter_threshold) live in the
 * PostgreSQL `destinations` row and are read at delivery time by the
 * runtime; this config only carries service-level toggles.
 *
 * Env var inventory (consumer-scoped):
 *
 *   POLARIS_META_CAPI_CONSUMER_GROUP        KafkaJS consumer group identifier
 *                                           default: "polaris-meta-capi-v1"
 *                                           default: 4
 *   POLARIS_META_CAPI_REQUEST_TIMEOUT_MS    HTTP fetch timeout per attempt
 *                                           default: 5000 (per manifest)
 *   POLARIS_META_CAPI_ALLOW_REPLAY          Toggle replay-suppression bypass
 *                                           default: false
 *   POLARIS_META_CAPI_GRAPH_HOST            Meta Graph API host
 *                                           default: "graph.facebook.com"
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
export const CONSUMER_SERVICE_NAME = "meta-capi" as const;

/**
 * Default Graph API host. Override via `POLARIS_META_CAPI_GRAPH_HOST`
 * for test environments or staging Meta endpoints.
 */
export const DEFAULT_GRAPH_HOST = "graph.facebook.com" as const;

/** Consumer-specific tuning knobs. */
export const metaCapiEnvSchema = z
  .object({
    POLARIS_META_CAPI_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-meta-capi-v1"),
    POLARIS_META_CAPI_REQUEST_TIMEOUT_MS: positiveIntSchema.default(5000),
    POLARIS_META_CAPI_ALLOW_REPLAY: booleanFromStringSchema.default(false),
    POLARIS_META_CAPI_GRAPH_HOST: nonEmptyStringSchema.default(DEFAULT_GRAPH_HOST),
  })
  .transform(
    (parsed): MetaCapiConfig => ({
      consumerGroup: parsed["POLARIS_META_CAPI_CONSUMER_GROUP"],
      requestTimeoutMs: parsed["POLARIS_META_CAPI_REQUEST_TIMEOUT_MS"],
      allowReplay: parsed["POLARIS_META_CAPI_ALLOW_REPLAY"],
      graphHost: parsed["POLARIS_META_CAPI_GRAPH_HOST"],
    }),
  );

export interface MetaCapiConfig {
  readonly consumerGroup: string;
  readonly requestTimeoutMs: number;
  readonly allowReplay: boolean;
  readonly graphHost: string;
}

export const metaCapiEnvKeys = [
  "POLARIS_META_CAPI_CONSUMER_GROUP",
  "POLARIS_META_CAPI_REQUEST_TIMEOUT_MS",
  "POLARIS_META_CAPI_ALLOW_REPLAY",
  "POLARIS_META_CAPI_GRAPH_HOST",
] as const;

export interface MetaCapiRuntimeConfig {
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
  readonly meta: MetaCapiConfig;
}

export function metaCapiConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    redis: redisEnvSchema,
    meta: metaCapiEnvSchema,
  });
}

export function loadMetaCapiConfig(): MetaCapiRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: CONSUMER_SERVICE_NAME,
    schema: metaCapiConfigSchema(),
  });
}
