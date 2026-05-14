/**
 * Runtime configuration for the webhook-sink v1 destination consumer.
 *
 * Composes the shared config fragments (service/http/redpanda/postgres) with
 * a vendor-specific block that tunes the consumer group, concurrency, and
 * HTTP timeout. Per-destination instance knobs (status, mode, max_rps,
 * retry_policy, dead_letter_threshold) live in the PostgreSQL `destinations`
 * row and are read at delivery time by the runtime; this config only carries
 * service-level toggles that apply to the whole process.
 *
 * Env var inventory (consumer-scoped):
 *
 *   POLARIS_WEBHOOK_SINK_CONSUMER_GROUP    KafkaJS consumer group identifier
 *                                          default: "polaris-webhook-sink-v1"
 *   POLARIS_WEBHOOK_SINK_CONCURRENCY       `partitionsConsumedConcurrently`
 *                                          default: 4
 *   POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS  HTTP fetch timeout per attempt
 *                                            default: 5000 (per manifest)
 *   POLARIS_WEBHOOK_SINK_ALLOW_REPLAY      Toggle replay-suppression bypass
 *                                          default: false
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
 * Default service name surfaced when `POLARIS_SERVICE_NAME` is omitted by
 * a deployment template. The shared config schema still requires the env
 * var, but this constant is what deployments are expected to set and what
 * the bootstrap reports through `/health`.
 */
export const CONSUMER_SERVICE_NAME = "webhook-sink" as const;

/**
 * Consumer-specific tuning knobs. The shape mirrors the analytics-projector
 * config block: a small set of env-driven values, transformed into a typed
 * config object the runtime consumes.
 */
export const webhookSinkEnvSchema = z
  .object({
    POLARIS_WEBHOOK_SINK_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-webhook-sink-v1"),
    POLARIS_WEBHOOK_SINK_CONCURRENCY: positiveIntSchema.default(4),
    POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS: positiveIntSchema.default(5000),
    POLARIS_WEBHOOK_SINK_ALLOW_REPLAY: booleanFromStringSchema.default(false),
  })
  .transform(
    (parsed): WebhookSinkConfig => ({
      consumerGroup: parsed["POLARIS_WEBHOOK_SINK_CONSUMER_GROUP"],
      partitionsConsumedConcurrently: parsed["POLARIS_WEBHOOK_SINK_CONCURRENCY"],
      requestTimeoutMs: parsed["POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS"],
      allowReplay: parsed["POLARIS_WEBHOOK_SINK_ALLOW_REPLAY"],
    }),
  );

export interface WebhookSinkConfig {
  /**
   * KafkaJS consumer group identifier. The default pins the directory name
   * + version so multiple replicas of webhook-sink v1 cooperate and a v2
   * deployment running in parallel uses a different group.
   */
  readonly consumerGroup: string;
  /**
   * Max partitions a single KafkaJS consumer instance reads in parallel.
   * Defaults to 4 — webhook delivery is I/O-bound so higher than the
   * processors' default of 1.
   */
  readonly partitionsConsumedConcurrently: number;
  /**
   * Per-attempt HTTP fetch timeout in milliseconds. Aligns with the
   * manifest `defaults.request_timeout_ms`.
   */
  readonly requestTimeoutMs: number;
  /**
   * When `true`, the runtime delivers replay traffic (events with
   * `polaris-replay: true` header) to the live destination. Default
   * `false` so replays never accidentally double-ship to webhook
   * receivers; operators flip this on through replay tooling's explicit
   * opt-in.
   */
  readonly allowReplay: boolean;
}

export const webhookSinkEnvKeys = [
  "POLARIS_WEBHOOK_SINK_CONSUMER_GROUP",
  "POLARIS_WEBHOOK_SINK_CONCURRENCY",
  "POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS",
  "POLARIS_WEBHOOK_SINK_ALLOW_REPLAY",
] as const;

/**
 * Full runtime configuration for the webhook-sink v1 service.
 *
 * Slots:
 *
 *   - service   — name, version, env, log level, build metadata
 *   - http      — host/port for /health, /ready, /metrics (no business routes)
 *   - redpanda  — broker list, SSL, SASL, timeouts
 *   - postgres  — destinations + delivery_records connection
 *   - sink      — consumer-specific knobs above
 */
export interface WebhookSinkRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly redpanda: RedpandaConfig;
  readonly postgres: PostgresConfig;
  readonly sink: WebhookSinkConfig;
}

/**
 * Compose the runtime config schema. Kept as a function so test runs can
 * rebuild the schema against synthetic env sources without sharing a single
 * Zod instance (matches the processor pattern).
 */
export function webhookSinkConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    redpanda: redpandaEnvSchema,
    postgres: postgresEnvSchema,
    sink: webhookSinkEnvSchema,
  });
}

/**
 * Load the runtime config. Throws `ConfigValidationError` (from
 * `@polaris/shared-config`) when any required value is missing or
 * malformed — services let that error crash the process so deployments
 * fail fast.
 */
export function loadWebhookSinkConfig(): WebhookSinkRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: CONSUMER_SERVICE_NAME,
    schema: webhookSinkConfigSchema(),
  });
}
