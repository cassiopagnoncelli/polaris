/**
 * Runtime configuration for the webhook-sink v1 destination consumer.
 *
 * Composes the shared config fragments (service/http/rabbitmq/postgres) with
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
 *                                          default: 4
 *   POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS  HTTP fetch timeout per attempt
 *                                            default: 5000 (per manifest)
 *   POLARIS_WEBHOOK_SINK_ALLOW_REPLAY      Toggle replay-suppression bypass
 *                                          default: false
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
    POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS: positiveIntSchema.default(5000),
    POLARIS_WEBHOOK_SINK_ALLOW_REPLAY: booleanFromStringSchema.default(false),
  })
  .transform(
    (parsed): WebhookSinkConfig => ({
      consumerGroup: parsed["POLARIS_WEBHOOK_SINK_CONSUMER_GROUP"],
      requestTimeoutMs: parsed["POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS"],
      allowReplay: parsed["POLARIS_WEBHOOK_SINK_ALLOW_REPLAY"],
    }),
  );

export interface WebhookSinkConfig {
  /**
   * Polaris consumer-group identifier: the namespace this consumer's
   * stream checkpoints live under in `transport_checkpoints`. Changing it
   * rewinds the consumer, so it is part of the deployment's contract.
   */
  readonly consumerGroup: string;
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
 *   - rabbitmq  — connection URL, TLS, partitions, checkpoint cadence
 *   - postgres  — destinations + delivery_records connection
 *   - sink      — consumer-specific knobs above
 */
export interface WebhookSinkRuntimeConfig {
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
    rabbitmq: rabbitmqEnvSchema,
    postgres: postgresEnvSchema,
    redis: redisEnvSchema,
    sink: webhookSinkEnvSchema,
  });
}

/**
 * Load the runtime config. Throws `ConfigValidationError` (from
 * `@polaris/runtime-config`) when any required value is missing or
 * malformed — services let that error crash the process so deployments
 * fail fast.
 */
export function loadWebhookSinkConfig(): WebhookSinkRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: CONSUMER_SERVICE_NAME,
    schema: webhookSinkConfigSchema(),
  });
}
