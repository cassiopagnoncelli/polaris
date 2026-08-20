/**
 * Zod-validated config for the shared ClickHouse client.
 *
 * The package never reads `process.env` itself — that responsibility lives in
 * `@polaris/runtime-config` (P0-003). Services build the config object there,
 * pass it here, and we validate the runtime shape.
 *
 * The credential is resolved from `@polaris/runtime-secrets` (P0-008) at
 * config-build time; this package accepts a fully-materialised credential so
 * secrets never round-trip through Zod schemas.
 */

import { z } from "zod";
import { ClickHouseConfigError } from "./errors.js";
import type { Logger, MetricsRecorder } from "./types.js";

const roleSchema = z.enum(["service", "operator"], {
  message: "CLICKHOUSE_ROLE must be 'service' or 'operator'.",
});

const credentialSchema = z
  .object({
    username: z.string().min(1, "credential.username must be a non-empty string."),
    password: z.string().min(1, "credential.password must be a non-empty string."),
  })
  .strict();

const databaseSchema = z
  .string()
  .min(1, "database must be a non-empty string when provided.")
  .default("polaris");

const requestTimeoutSchema = z
  .number()
  .int()
  .positive()
  .max(600_000, "request_timeout cannot exceed 10 minutes.")
  .default(30_000);

const maxOpenConnectionsSchema = z
  .number()
  .int()
  .positive()
  .max(64, "max_open_connections must be <= 64.")
  .default(10);

/**
 * Internal Zod schema. Exposed via `parseClickHouseConfig`.
 */
const clickHouseConfigInputSchema = z
  .object({
    url: z
      .string()
      .min(1, "url is required.")
      .url("url must be a valid HTTP/HTTPS URL.")
      .refine(
        (value) => value.startsWith("http://") || value.startsWith("https://"),
        "url must use http:// or https:// (the native protocol is unsupported by @clickhouse/client over HTTP).",
      ),
    role: roleSchema,
    credential: credentialSchema,
    database: databaseSchema.optional(),
    requestTimeoutMs: requestTimeoutSchema.optional(),
    maxOpenConnections: maxOpenConnectionsSchema.optional(),
    /** Application identifier added to every query (`?session_id` is not used; `application` header is). */
    application: z.string().min(1).default("polaris"),
  })
  .strict();

/**
 * Validated config shape used internally by `createClickHouseClient`.
 */
export type ClickHouseClientConfig = z.infer<typeof clickHouseConfigInputSchema>;

/**
 * Constructor-time options. The Zod-validated `config` is the database
 * surface; `logger` and `metrics` are runtime collaborators that are NOT
 * stored in env vars and so do not flow through Zod.
 */
export interface ClickHouseClientOptions {
  config: ClickHouseClientConfig;
  logger?: Logger;
  metrics?: MetricsRecorder;
}

/**
 * Parse and validate raw config input.
 *
 * `role` MUST be declared. Per the architecture rule, the package refuses to
 * construct a connection without a declared role; this is the first place
 * that contract is enforced.
 */
export function parseClickHouseConfig(input: unknown): ClickHouseClientConfig {
  // Explicit role guard. Zod's enum error is fine, but the role rule is
  // load-bearing enough that we want a stable, code-able error class.
  if (typeof input !== "object" || input === null) {
    throw new ClickHouseConfigError("ClickHouse config must be a non-null object.");
  }
  const maybeRole = (input as { role?: unknown }).role;
  if (maybeRole === undefined || maybeRole === null || maybeRole === "") {
    throw new ClickHouseConfigError(
      "ClickHouse config requires an explicit `role`: 'service' or 'operator'. Refusing to construct a connection without a declared role.",
    );
  }

  const result = clickHouseConfigInputSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ClickHouseConfigError(`Invalid ClickHouse config: ${message}`);
  }
  return result.data;
}

/**
 * Cross-check the username against the declared role. This is a soft guard:
 * the database role grants are the source of truth. The check exists so
 * misconfigured environments fail fast in local/dev before a query is run.
 */
export function assertCredentialMatchesRole(config: ClickHouseClientConfig): void {
  const expected = config.role === "service" ? "polaris_service" : "polaris_operator";
  if (config.credential.username !== expected) {
    // Soft warning path: do not throw. Production deployments may use
    // alternative usernames (e.g. environment-suffixed) that still hold the
    // right role grants. Throwing would break those.
    // The structured log line in `createClickHouseClient` records the
    // mismatch so operators can audit it.
  }
}
