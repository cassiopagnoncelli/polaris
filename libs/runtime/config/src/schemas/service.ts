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
 *   POLARIS_SERVICE_NAME    required — short identifier (e.g. "ingester-api")
 *   POLARIS_SERVICE_VERSION (`"0.0.0"`) — package version stamped by build.
 *                           Falls back to `POLARIS_BUILD_VERSION` when not set
 *                           so containerized runs that only inject the
 *                           Dockerfile build arg pick the same value up.
 *   POLARIS_BUILD_VERSION   (optional) — Dockerfile build arg alias for
 *                           `POLARIS_SERVICE_VERSION`. Either name works at
 *                           runtime; the build pipeline stamps the docker
 *                           build arg name, the test/dev shells use the
 *                           service-prefixed name. See P11-007.
 *   POLARIS_ENV             required — local | development | staging | production
 *   POLARIS_LOG_LEVEL       (`"info"`) — Pino level
 *   POLARIS_LOG_PRETTY      (`true` for local, `false` otherwise) — pretty stdout
 *   POLARIS_GIT_SHA         (optional) — embedded by the container build
 *   POLARIS_BUILD_TIME      (optional) — ISO 8601 build timestamp
 *   POLARIS_RELEASE_LABEL   (optional) — free-form human-readable pipeline
 *                           release tag (e.g. `2026-q2-r1`). Useful when
 *                           bisecting which production rollout introduced a
 *                           behavior change. See P11-007.
 *
 * The schema parses an object keyed by env var name. Callers that want a
 * camel-cased object should compose it from the parsed result.
 */
export const serviceEnvSchema = z
  .object({
    POLARIS_SERVICE_NAME: nonEmptyStringSchema,
    // `POLARIS_SERVICE_VERSION` and `POLARIS_BUILD_VERSION` are aliases. The
    // schema accepts either and prefers the service-prefixed one when both
    // are set; otherwise it falls back to the build-arg name and then to the
    // default. This makes the existing Dockerfile injection (which sets
    // `POLARIS_BUILD_VERSION` only) surface the real version in
    // `/health.version`, log bindings, and runtime stamps without forcing a
    // sweep of the Dockerfiles.
    POLARIS_SERVICE_VERSION: nonEmptyStringSchema.optional(),
    POLARIS_BUILD_VERSION: nonEmptyStringSchema.optional(),
    POLARIS_ENV: environmentSchema,
    POLARIS_LOG_LEVEL: logLevelSchema.default("info"),
    POLARIS_LOG_PRETTY: booleanFromStringSchema.optional(),
    POLARIS_GIT_SHA: nonEmptyStringSchema.optional(),
    POLARIS_BUILD_TIME: nonEmptyStringSchema.optional(),
    POLARIS_RELEASE_LABEL: nonEmptyStringSchema.optional(),
  })
  .transform((parsed): ServiceConfig => {
    const isLocal = parsed.POLARIS_ENV === "local";
    return {
      serviceName: parsed.POLARIS_SERVICE_NAME,
      serviceVersion: parsed.POLARIS_SERVICE_VERSION ?? parsed.POLARIS_BUILD_VERSION ?? "0.0.0",
      environment: parsed.POLARIS_ENV,
      logLevel: parsed.POLARIS_LOG_LEVEL,
      logPretty: parsed.POLARIS_LOG_PRETTY ?? isLocal,
      gitSha: parsed.POLARIS_GIT_SHA,
      buildTime: parsed.POLARIS_BUILD_TIME,
      releaseLabel: parsed.POLARIS_RELEASE_LABEL,
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
  /**
   * Optional human-readable pipeline release label (e.g. `2026-q2-r1`).
   * Surfaced on `/health.release_label`, log bindings, and the polaris-cli
   * `version` output. Separate from `serviceVersion`, which is the package
   * version: a single release label may bundle many packages with distinct
   * package versions. See `docs/deployment/versioning.md`.
   */
  readonly releaseLabel: string | undefined;
}

/**
 * Variable names the service schema reads. Useful when composing a manual
 * picker for env vars in tests.
 */
export const serviceEnvKeys = [
  "POLARIS_SERVICE_NAME",
  "POLARIS_SERVICE_VERSION",
  "POLARIS_BUILD_VERSION",
  "POLARIS_ENV",
  "POLARIS_LOG_LEVEL",
  "POLARIS_LOG_PRETTY",
  "POLARIS_GIT_SHA",
  "POLARIS_BUILD_TIME",
  "POLARIS_RELEASE_LABEL",
] as const;
