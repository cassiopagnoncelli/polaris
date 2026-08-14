/**
 * Runtime configuration for the meta-capi v1 destination consumer.
 *
 * Mirrors the webhook-sink v1 shape (`consumers/webhook-sink/v1/src/
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
  rabbitmqEnvSchema,
  type ServiceConfig,
  serviceEnvSchema,
} from "@polaris/shared-config";
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
  readonly meta: MetaCapiConfig;
}

export function metaCapiConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    meta: metaCapiEnvSchema,
  });
}

export function loadMetaCapiConfig(): MetaCapiRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: CONSUMER_SERVICE_NAME,
    schema: metaCapiConfigSchema(),
  });
}
