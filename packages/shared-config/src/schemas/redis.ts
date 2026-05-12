import { z } from "zod";
import {
  durationMsSchema,
  nonEmptyStringSchema,
  nonNegativeIntSchema,
  portSchema,
} from "./common.js";

/**
 * Redis connection config.
 *
 * Redis stores short-lived state only (dedupe window, rate limit counters,
 * ephemeral processor caches). Losing Redis is acceptable.
 *
 * Env vars:
 *
 *   POLARIS_REDIS_HOST              required
 *   POLARIS_REDIS_PORT              (6379)
 *   POLARIS_REDIS_DB                (0) — DB index (0..15)
 *   POLARIS_REDIS_USERNAME          (optional)
 *   POLARIS_REDIS_PASSWORD          (optional)
 *   POLARIS_REDIS_CONNECT_TIMEOUT_MS (5000)
 *   POLARIS_REDIS_KEY_PREFIX        (optional) — namespacing prefix
 */
export const redisEnvSchema = z
  .object({
    POLARIS_REDIS_HOST: nonEmptyStringSchema,
    POLARIS_REDIS_PORT: portSchema.default(6379),
    POLARIS_REDIS_DB: nonNegativeIntSchema.max(15, "Redis DB index must be 0..15").default(0),
    POLARIS_REDIS_USERNAME: nonEmptyStringSchema.optional(),
    POLARIS_REDIS_PASSWORD: nonEmptyStringSchema.optional(),
    POLARIS_REDIS_CONNECT_TIMEOUT_MS: durationMsSchema.default(5_000),
    POLARIS_REDIS_KEY_PREFIX: nonEmptyStringSchema.optional(),
  })
  .transform(
    (parsed): RedisConfig => ({
      host: parsed.POLARIS_REDIS_HOST,
      port: parsed.POLARIS_REDIS_PORT,
      db: parsed.POLARIS_REDIS_DB,
      username: parsed.POLARIS_REDIS_USERNAME,
      password: parsed.POLARIS_REDIS_PASSWORD,
      connectTimeoutMs: parsed.POLARIS_REDIS_CONNECT_TIMEOUT_MS,
      keyPrefix: parsed.POLARIS_REDIS_KEY_PREFIX,
    }),
  );

export interface RedisConfig {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly connectTimeoutMs: number;
  readonly keyPrefix: string | undefined;
}

export const redisEnvKeys = [
  "POLARIS_REDIS_HOST",
  "POLARIS_REDIS_PORT",
  "POLARIS_REDIS_DB",
  "POLARIS_REDIS_USERNAME",
  "POLARIS_REDIS_PASSWORD",
  "POLARIS_REDIS_CONNECT_TIMEOUT_MS",
  "POLARIS_REDIS_KEY_PREFIX",
] as const;
