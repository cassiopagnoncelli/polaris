import {
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
} from "@polaris/shared-config";
import { z } from "zod";

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
 *   POLARIS_SESSIONIZER_CONSUMER_GROUP        ("polaris-sessionizer-v2")
 *   POLARIS_SESSIONIZER_INACTIVITY_SECONDS    (1800)
 *
 * NOTE on `POLARIS_SESSIONIZER_INACTIVITY_SECONDS`: the inactivity window
 * is SEMANTIC per the processor manifest. Changing it would alter the
 * emitted `session.started` / `session.ended` events for the same input
 * slice — a wider window merges sessions this version would have split, a
 * narrower one splits sessions it would have merged. A real change requires a new
 * processor version (v2 directory + new manifest).
 *
 * The runtime therefore ACCEPTS this variable and IGNORES its value: the
 * window always comes from the manifest constant. Operators may set it to
 * mirror the manifest for transparency, and `app.ts` logs a warn when the
 * two disagree so a misconfiguration surfaces in the logs rather than in
 * a session count.
 *
 * This used to be a promise rather than a behaviour — the comment claimed
 * the runtime "ignores attempts to widen it" while the configured value
 * was passed straight through in both directions. See CHANGELOG.
 */
export const sessionizerEnvSchema = z
  .object({
    POLARIS_SESSIONIZER_CONSUMER_GROUP: nonEmptyStringSchema.default("polaris-sessionizer-v2"),
    POLARIS_SESSIONIZER_INACTIVITY_SECONDS: positiveIntSchema.default(DEFAULT_INACTIVITY_SECONDS),
    /**
     * Redis key namespace for session records. Distinct from the
     * ingester's dedupe prefix so the two cannot collide in a shared
     * Redis, and so `SCAN`ing one during an incident does not walk the
     * other.
     */
    POLARIS_SESSIONIZER_REDIS_KEY_PREFIX: nonEmptyStringSchema.default("polaris:session"),
    /**
     * Hard deadline per Redis call. Unlike the ingester's dedupe store,
     * a timeout here fails the message rather than degrading — see the
     * note in `redis-store.ts` — so this bounds how long a sick Redis
     * takes to turn into a redelivery instead of a hang.
     */
    POLARIS_SESSIONIZER_REDIS_OP_TIMEOUT_MS: positiveIntSchema.default(250),
  })
  .transform(
    (parsed): SessionizerConfig => ({
      consumerGroup: parsed["POLARIS_SESSIONIZER_CONSUMER_GROUP"],
      inactivitySeconds: parsed["POLARIS_SESSIONIZER_INACTIVITY_SECONDS"],
      redisKeyPrefix: parsed["POLARIS_SESSIONIZER_REDIS_KEY_PREFIX"],
      redisOpTimeoutMs: parsed["POLARIS_SESSIONIZER_REDIS_OP_TIMEOUT_MS"],
    }),
  );

export interface SessionizerConfig {
  readonly consumerGroup: string;
  readonly inactivitySeconds: number;
  readonly redisKeyPrefix: string;
  readonly redisOpTimeoutMs: number;
}

export const sessionizerEnvKeys = [
  "POLARIS_SESSIONIZER_CONSUMER_GROUP",
  "POLARIS_SESSIONIZER_INACTIVITY_SECONDS",
  "POLARIS_SESSIONIZER_REDIS_KEY_PREFIX",
  "POLARIS_SESSIONIZER_REDIS_OP_TIMEOUT_MS",
] as const;

/**
 * Full runtime configuration for the sessionizer v2 service.
 */
export interface SessionizerRuntimeConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  /**
   * PostgreSQL connection. Required since the RabbitMQ migration: stream
   * consumers own their resume point (`transport_checkpoints`) because
   * AMQP has no server-side offset store.
   */
  readonly postgres: PostgresConfig;
  readonly rabbitmq: RabbitmqConfig;
  /**
   * Redis connection for the session store. Required since ADR 0005:
   * session windows live in Redis so they survive a restart and so key
   * expiry carries the inactivity rule.
   */
  readonly redis: RedisConfig;
  readonly sessionizer: SessionizerConfig;
}

export function sessionizerConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    postgres: postgresEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    redis: redisEnvSchema,
    sessionizer: sessionizerEnvSchema,
  });
}

export function loadSessionizerConfig(): SessionizerRuntimeConfig {
  return loadConfigWithDefaults({
    serviceName: PROCESSOR_SERVICE_NAME,
    schema: sessionizerConfigSchema(),
  });
}
