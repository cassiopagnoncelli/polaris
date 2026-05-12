import { z } from "zod";
import { durationMsSchema, nonEmptyStringSchema, positiveIntSchema } from "./common.js";

/**
 * ClickHouse client config.
 *
 * Services and CLI code never import `@clickhouse/client` directly — they go
 * through `packages/shared-clickhouse/`, which receives this config object.
 * The helper exposes two profiles (`service` for read-only projection access
 * and `operator` for the broader access needed by replay/rebuild jobs); the
 * profile is selected at call time, not from config, so a single deployment
 * can switch between them based on operation.
 *
 * Env vars:
 *
 *   POLARIS_CLICKHOUSE_URL                required — full HTTP URL incl. scheme
 *   POLARIS_CLICKHOUSE_DATABASE           required
 *   POLARIS_CLICKHOUSE_SERVICE_USER       required — username for polaris_service role
 *   POLARIS_CLICKHOUSE_SERVICE_PASSWORD   required
 *   POLARIS_CLICKHOUSE_OPERATOR_USER      (optional) — polaris_operator role
 *   POLARIS_CLICKHOUSE_OPERATOR_PASSWORD  (optional)
 *   POLARIS_CLICKHOUSE_REQUEST_TIMEOUT_MS (30000)
 *   POLARIS_CLICKHOUSE_MAX_OPEN_CONNECTIONS (10)
 */
export const clickhouseUrlSchema = z
  .string()
  .trim()
  .min(1, "must be a non-empty URL")
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "must be an http:// or https:// URL" },
  );

export const clickhouseEnvSchema = z
  .object({
    POLARIS_CLICKHOUSE_URL: clickhouseUrlSchema,
    POLARIS_CLICKHOUSE_DATABASE: nonEmptyStringSchema,
    POLARIS_CLICKHOUSE_SERVICE_USER: nonEmptyStringSchema,
    POLARIS_CLICKHOUSE_SERVICE_PASSWORD: nonEmptyStringSchema,
    POLARIS_CLICKHOUSE_OPERATOR_USER: nonEmptyStringSchema.optional(),
    POLARIS_CLICKHOUSE_OPERATOR_PASSWORD: nonEmptyStringSchema.optional(),
    POLARIS_CLICKHOUSE_REQUEST_TIMEOUT_MS: durationMsSchema.default(30_000),
    POLARIS_CLICKHOUSE_MAX_OPEN_CONNECTIONS: positiveIntSchema.default(10),
  })
  .superRefine((parsed, ctx) => {
    const hasUser = parsed.POLARIS_CLICKHOUSE_OPERATOR_USER !== undefined;
    const hasPassword = parsed.POLARIS_CLICKHOUSE_OPERATOR_PASSWORD !== undefined;
    if (hasUser !== hasPassword) {
      ctx.addIssue({
        code: "custom",
        path: hasUser
          ? ["POLARIS_CLICKHOUSE_OPERATOR_PASSWORD"]
          : ["POLARIS_CLICKHOUSE_OPERATOR_USER"],
        message:
          "POLARIS_CLICKHOUSE_OPERATOR_USER and POLARIS_CLICKHOUSE_OPERATOR_PASSWORD must be set together",
      });
    }
  })
  .transform((parsed): ClickHouseConfig => {
    const operator =
      parsed.POLARIS_CLICKHOUSE_OPERATOR_USER !== undefined &&
      parsed.POLARIS_CLICKHOUSE_OPERATOR_PASSWORD !== undefined
        ? ({
            user: parsed.POLARIS_CLICKHOUSE_OPERATOR_USER,
            password: parsed.POLARIS_CLICKHOUSE_OPERATOR_PASSWORD,
          } as const)
        : undefined;
    return {
      url: parsed.POLARIS_CLICKHOUSE_URL,
      database: parsed.POLARIS_CLICKHOUSE_DATABASE,
      service: {
        user: parsed.POLARIS_CLICKHOUSE_SERVICE_USER,
        password: parsed.POLARIS_CLICKHOUSE_SERVICE_PASSWORD,
      },
      operator,
      requestTimeoutMs: parsed.POLARIS_CLICKHOUSE_REQUEST_TIMEOUT_MS,
      maxOpenConnections: parsed.POLARIS_CLICKHOUSE_MAX_OPEN_CONNECTIONS,
    };
  });

export interface ClickHouseRoleCredentials {
  readonly user: string;
  readonly password: string;
}

export interface ClickHouseConfig {
  readonly url: string;
  readonly database: string;
  readonly service: ClickHouseRoleCredentials;
  readonly operator: ClickHouseRoleCredentials | undefined;
  readonly requestTimeoutMs: number;
  readonly maxOpenConnections: number;
}

export const clickhouseEnvKeys = [
  "POLARIS_CLICKHOUSE_URL",
  "POLARIS_CLICKHOUSE_DATABASE",
  "POLARIS_CLICKHOUSE_SERVICE_USER",
  "POLARIS_CLICKHOUSE_SERVICE_PASSWORD",
  "POLARIS_CLICKHOUSE_OPERATOR_USER",
  "POLARIS_CLICKHOUSE_OPERATOR_PASSWORD",
  "POLARIS_CLICKHOUSE_REQUEST_TIMEOUT_MS",
  "POLARIS_CLICKHOUSE_MAX_OPEN_CONNECTIONS",
] as const;
