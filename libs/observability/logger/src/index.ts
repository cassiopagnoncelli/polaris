/**
 * `@polaris/shared-logger` — Pino-based structured logger for Polaris services.
 *
 * Polaris services emit JSON-only logs. This package centralises:
 *
 *   - factory creation with service-binding metadata
 *   - baked-in redaction for secrets, authorization headers, cookies, tokens,
 *     card fields, passwords, and raw event payloads
 *   - typed child-logger helpers for request / source / processor / consumer /
 *     replay / message scopes
 *   - standard log-field types matching `09-engineering-standards.md` and
 *     `08-observability-and-operations.md`
 *
 * Services depend on this package and never import `pino` directly. The
 * coordinated upstream version, redaction defaults, and binding shape live
 * here so platform-wide changes (new secret category, new context scope) ship
 * through a single package release.
 *
 * @see docs/architecture/09-engineering-standards.md "Logging"
 * @see docs/architecture/08-observability-and-operations.md "Standard Log Fields"
 */

export {
  type ConsumerContext,
  type ProcessorContext,
  type ReplayContext,
  type RequestContext,
  type SourceContext,
  withConsumer,
  withMessage,
  withProcessor,
  withReplay,
  withRequest,
  withSource,
} from "./context.js";
export { createLogger, type Logger } from "./logger.js";
export { DEFAULT_REDACTION_PATHS, REDACTION_CENSOR, resolveRedactionPaths } from "./redaction.js";

export type { LoggerOptions, LogLevel, ServiceBinding, StandardLogFields } from "./types.js";
