import { z } from "zod";
import { durationMsSchema, nonEmptyStringSchema, portSchema } from "./common.js";

/**
 * HTTP server config for Fastify-backed services (ingester, control-plane API).
 *
 * Env vars:
 *
 *   POLARIS_HTTP_HOST              ("0.0.0.0")
 *   POLARIS_HTTP_PORT              (3000)
 *   POLARIS_HTTP_BODY_LIMIT_BYTES  (1048576 — 1 MiB)
 *   POLARIS_HTTP_REQUEST_TIMEOUT_MS (15000)
 *   POLARIS_HTTP_KEEPALIVE_TIMEOUT_MS (5000)
 */
export const httpEnvSchema = z
  .object({
    POLARIS_HTTP_HOST: nonEmptyStringSchema.default("0.0.0.0"),
    POLARIS_HTTP_PORT: portSchema.default(3000),
    POLARIS_HTTP_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1, "POLARIS_HTTP_BODY_LIMIT_BYTES must be >= 1")
      .default(1_048_576),
    POLARIS_HTTP_REQUEST_TIMEOUT_MS: durationMsSchema.default(15_000),
    POLARIS_HTTP_KEEPALIVE_TIMEOUT_MS: durationMsSchema.default(5_000),
  })
  .transform(
    (parsed): HttpConfig => ({
      host: parsed.POLARIS_HTTP_HOST,
      port: parsed.POLARIS_HTTP_PORT,
      bodyLimitBytes: parsed.POLARIS_HTTP_BODY_LIMIT_BYTES,
      requestTimeoutMs: parsed.POLARIS_HTTP_REQUEST_TIMEOUT_MS,
      keepAliveTimeoutMs: parsed.POLARIS_HTTP_KEEPALIVE_TIMEOUT_MS,
    }),
  );

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
}

export const httpEnvKeys = [
  "POLARIS_HTTP_HOST",
  "POLARIS_HTTP_PORT",
  "POLARIS_HTTP_BODY_LIMIT_BYTES",
  "POLARIS_HTTP_REQUEST_TIMEOUT_MS",
  "POLARIS_HTTP_KEEPALIVE_TIMEOUT_MS",
] as const;
