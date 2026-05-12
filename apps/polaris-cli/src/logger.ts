import { createLogger, type Logger } from "@polaris/shared-logger";
import type { CliLogLevel } from "./config.js";
import type { PackageMeta } from "./package-meta.js";

/**
 * Build the CLI's root logger.
 *
 * The CLI shares `@polaris/shared-logger` with services so log lines come out
 * of the same redaction list. Logs go to stderr so command output on stdout
 * stays clean and pipeable.
 *
 * The default level is `warn` because operators typically run the CLI
 * interactively and do not want a JSON log line every time they list
 * something. `--debug` lifts the level to `debug`; `--quiet` lowers it to
 * `error`; `POLARIS_LOG_LEVEL` overrides explicitly.
 */
export function createCliLogger(options: {
  readonly level: CliLogLevel;
  readonly meta: PackageMeta;
  readonly env: string | undefined;
}): Logger {
  return createLogger({
    service: "polaris-cli",
    version: options.meta.version,
    ...(options.env !== undefined ? { env: options.env } : {}),
    level: options.level,
    destination: process.stderr,
    additionalRedactionPaths: [
      // Token-shaped fields commonly carried in the CLI's HTTP layer.
      "headers.authorization",
      'headers["x-polaris-operator-token"]',
      // The CLI's own resolved config object includes the bearer token.
      "config.token",
      "*.config.token",
    ],
  });
}
