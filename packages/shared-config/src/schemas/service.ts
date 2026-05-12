import { z } from "zod";
import {
  booleanFromStringSchema,
  environmentSchema,
  logLevelSchema,
  nonEmptyStringSchema,
} from "./common.js";

/**
 * Common runtime metadata every Polaris service needs.
 *
 * Maps from these env vars (defaults shown in parentheses):
 *
 *   POLARIS_SERVICE_NAME   required — short identifier (e.g. "ingester-api")
 *   POLARIS_SERVICE_VERSION (`"0.0.0"`) — package version stamped by build
 *   POLARIS_ENV            required — local | development | staging | production
 *   POLARIS_LOG_LEVEL      (`"info"` in dev/local, `"info"` everywhere) — Pino level
 *   POLARIS_LOG_PRETTY     (`true` for local, `false` otherwise) — pretty stdout
 *   POLARIS_GIT_SHA        (optional) — embedded by the container build
 *   POLARIS_BUILD_TIME     (optional) — ISO 8601 build timestamp
 *
 * The schema parses an object keyed by env var name. Callers that want a
 * camel-cased object should compose it from the parsed result.
 */
export const serviceEnvSchema = z
  .object({
    POLARIS_SERVICE_NAME: nonEmptyStringSchema,
    POLARIS_SERVICE_VERSION: nonEmptyStringSchema.default("0.0.0"),
    POLARIS_ENV: environmentSchema,
    POLARIS_LOG_LEVEL: logLevelSchema.default("info"),
    POLARIS_LOG_PRETTY: booleanFromStringSchema.optional(),
    POLARIS_GIT_SHA: nonEmptyStringSchema.optional(),
    POLARIS_BUILD_TIME: nonEmptyStringSchema.optional(),
  })
  .transform((parsed): ServiceConfig => {
    const isLocal = parsed.POLARIS_ENV === "local";
    return {
      serviceName: parsed.POLARIS_SERVICE_NAME,
      serviceVersion: parsed.POLARIS_SERVICE_VERSION,
      environment: parsed.POLARIS_ENV,
      logLevel: parsed.POLARIS_LOG_LEVEL,
      logPretty: parsed.POLARIS_LOG_PRETTY ?? isLocal,
      gitSha: parsed.POLARIS_GIT_SHA,
      buildTime: parsed.POLARIS_BUILD_TIME,
    };
  });

export interface ServiceConfig {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: z.infer<typeof environmentSchema>;
  readonly logLevel: z.infer<typeof logLevelSchema>;
  readonly logPretty: boolean;
  readonly gitSha: string | undefined;
  readonly buildTime: string | undefined;
}

/**
 * Variable names the service schema reads. Useful when composing a manual
 * picker for env vars in tests.
 */
export const serviceEnvKeys = [
  "POLARIS_SERVICE_NAME",
  "POLARIS_SERVICE_VERSION",
  "POLARIS_ENV",
  "POLARIS_LOG_LEVEL",
  "POLARIS_LOG_PRETTY",
  "POLARIS_GIT_SHA",
  "POLARIS_BUILD_TIME",
] as const;
