import { z } from "zod";
import {
  booleanFromStringSchema,
  durationMsSchema,
  nonEmptyStringSchema,
  portSchema,
  positiveIntSchema,
} from "./common.js";

/**
 * PostgreSQL connection config.
 *
 * Env vars:
 *
 *   POLARIS_POSTGRES_HOST        required — hostname
 *   POLARIS_POSTGRES_PORT        (5432)
 *   POLARIS_POSTGRES_DATABASE    required — database name
 *   POLARIS_POSTGRES_USER        required — username
 *   POLARIS_POSTGRES_PASSWORD    required — password
 *   POLARIS_POSTGRES_SSL         (false)
 *   POLARIS_POSTGRES_POOL_MAX    (10)
 *   POLARIS_POSTGRES_CONNECT_TIMEOUT_MS (10000)
 *   POLARIS_POSTGRES_IDLE_TIMEOUT_MS    (30000)
 *
 * Polaris loads passwords directly from env in v1; production hosts inject
 * them via the secret provider package (P0-008) which writes them into the
 * process environment before the service boots.
 */
export const postgresEnvSchema = z
  .object({
    POLARIS_POSTGRES_HOST: nonEmptyStringSchema,
    POLARIS_POSTGRES_PORT: portSchema.default(5432),
    POLARIS_POSTGRES_DATABASE: nonEmptyStringSchema,
    POLARIS_POSTGRES_USER: nonEmptyStringSchema,
    POLARIS_POSTGRES_PASSWORD: nonEmptyStringSchema,
    POLARIS_POSTGRES_SSL: booleanFromStringSchema.default(false),
    POLARIS_POSTGRES_POOL_MAX: positiveIntSchema.default(10),
    POLARIS_POSTGRES_CONNECT_TIMEOUT_MS: durationMsSchema.default(10_000),
    POLARIS_POSTGRES_IDLE_TIMEOUT_MS: durationMsSchema.default(30_000),
  })
  .transform(
    (parsed): PostgresConfig => ({
      host: parsed.POLARIS_POSTGRES_HOST,
      port: parsed.POLARIS_POSTGRES_PORT,
      database: parsed.POLARIS_POSTGRES_DATABASE,
      user: parsed.POLARIS_POSTGRES_USER,
      password: parsed.POLARIS_POSTGRES_PASSWORD,
      ssl: parsed.POLARIS_POSTGRES_SSL,
      poolMax: parsed.POLARIS_POSTGRES_POOL_MAX,
      connectTimeoutMs: parsed.POLARIS_POSTGRES_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: parsed.POLARIS_POSTGRES_IDLE_TIMEOUT_MS,
    }),
  );

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: boolean;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

export const postgresEnvKeys = [
  "POLARIS_POSTGRES_HOST",
  "POLARIS_POSTGRES_PORT",
  "POLARIS_POSTGRES_DATABASE",
  "POLARIS_POSTGRES_USER",
  "POLARIS_POSTGRES_PASSWORD",
  "POLARIS_POSTGRES_SSL",
  "POLARIS_POSTGRES_POOL_MAX",
  "POLARIS_POSTGRES_CONNECT_TIMEOUT_MS",
  "POLARIS_POSTGRES_IDLE_TIMEOUT_MS",
] as const;
