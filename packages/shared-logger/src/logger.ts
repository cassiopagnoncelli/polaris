import { hostname as osHostname } from "node:os";
import pino, { type Logger, type LoggerOptions as PinoLoggerOptions } from "pino";

import { REDACTION_CENSOR, resolveRedactionPaths } from "./redaction.js";
import type { LoggerOptions } from "./types.js";

/**
 * Re-exported Pino `Logger` type. Consumers should depend on this re-export
 * rather than importing `pino` directly to keep the upstream version
 * coordinated through this shared package.
 */
export type { Logger } from "pino";

/**
 * Create a Pino logger configured for Polaris services.
 *
 * The returned logger:
 *
 *   - emits JSON only (no pretty-printing)
 *   - attaches `service`, optional `version` / `env` / `hostname` / `region`
 *     to every line as fixed bindings
 *   - redacts a baked-in list of secret / authorization / cookie / card /
 *     token / payload paths. See `redaction.ts` for the full list.
 *   - timestamps every line with an ISO-8601 UTC string under the `time` key,
 *     replacing Pino's default millisecond integer so logs are directly
 *     human-readable and align with the event envelope timestamps.
 *   - rewrites Pino's default `level` integer to its string label (`info`,
 *     `warn`, ...) so Loki / Grafana filters work without a numeric mapping.
 *
 * The base logger has no per-request context. Use the helpers in `context.ts`
 * to create child loggers carrying request / source / processor / consumer /
 * replay-job context.
 *
 * @example
 * ```ts
 * import { createLogger, withRequest } from "@polaris/shared-logger";
 *
 * const root = createLogger({
 *   service: "ingester-api",
 *   version: process.env.POLARIS_BUILD_VERSION,
 *   env: process.env.POLARIS_ENV,
 * });
 *
 * // attach request context
 * const reqLog = root.child(withRequest({ request_id, project_id, environment }));
 * reqLog.info({ event_id }, "event accepted");
 * ```
 */
export function createLogger(options: LoggerOptions): Logger {
  const {
    service,
    version,
    env,
    hostname,
    region,
    level = "info",
    additionalRedactionPaths,
    bindings,
    destination,
    timeFn,
  } = options;

  const base: Record<string, unknown> = {
    service,
  };
  if (version !== undefined) base["version"] = version;
  if (env !== undefined) base["env"] = env;
  if (region !== undefined) base["region"] = region;
  base["hostname"] = hostname ?? osHostname();
  if (bindings !== undefined) {
    for (const [key, value] of Object.entries(bindings)) {
      // Service-binding keys are reserved.
      if (key in base) continue;
      base[key] = value;
    }
  }

  const pinoOptions: PinoLoggerOptions = {
    level,
    base,
    // ISO-8601 UTC timestamps. Pino's default is millisecond integers, which
    // is fine for ingestion-time log shippers but awkward for human triage
    // and for joining against `occurred_at` / `ingested_at` on events.
    timestamp: () => `,"time":"${(timeFn ?? defaultTimeFn)()}"`,
    formatters: {
      // Emit textual log levels (`info`, `warn`, ...) rather than the numeric
      // default. Loki / Grafana / runbooks all read text levels.
      level: (label) => ({ level: label }),
    },
    messageKey: "message",
    errorKey: "error",
    redact: {
      paths: resolveRedactionPaths(additionalRedactionPaths),
      censor: REDACTION_CENSOR,
      remove: false,
    },
  };

  return destination !== undefined ? pino(pinoOptions, destination) : pino(pinoOptions);
}

function defaultTimeFn(): string {
  return new Date().toISOString();
}
