/**
 * Retry classification for processor errors.
 *
 * Per `docs/architecture/03-rabbitmq-streams.md` "Retry and DLQ Topics" and
 * `09-engineering-standards.md` "HTTP Error Contract", Polaris distinguishes
 * retryable from permanent failures. Processors and consumers branch on
 * this classification to decide whether the next attempt goes to the retry
 * topic or straight to the DLQ.
 *
 * The classifier in this module is the SHARED policy: it inspects an error
 * (KafkaJS errors, schema-validation errors, our own `EventDeserializationError`,
 * generic `Error`) and returns a small structured verdict that callers can
 * route on. The verdict's `reason` field uses the canonical reason-code set
 * from `@polaris/spec` where it overlaps with ingestion (e.g.
 * `invalid_envelope`, `publish_failed`) and a small processor-specific
 * vocabulary for cases ingestion does not name (network errors, decode
 * failures).
 *
 * Processor-specific retry budgets (max attempts, backoff window) are NOT
 * owned here. They live next to the processor's runtime configuration so a
 * heavier processor (geoip enrich, identity resolution) can tune them
 * without forking the classifier.
 *
 * @see libs/spec/src/reason-codes.ts
 * @see libs/bus/src/dlq.ts
 */

import {
  BATCH_REASON_INVALID_REQUEST,
  BATCH_REASON_PUBLISH_FAILED,
  SCHEMA_REASON_INVALID_ENVELOPE,
  SCHEMA_REASON_INVALID_PROPERTIES,
  SCHEMA_REASON_SUNSET,
  SCHEMA_REASON_UNKNOWN_EVENT,
  SCHEMA_REASON_UNSUPPORTED_VERSION,
} from "@polaris/spec";

/**
 * Reason vocabulary used by the classifier. The values are intentionally
 * stable across processor versions so retry/DLQ topic headers and
 * dashboards can pivot on them without consulting per-processor docs.
 *
 * The first five values are reused verbatim from
 * `@polaris/spec`'s schema-reason-code set. The remaining values
 * are processor-flow specific and have no ingestion analogue.
 */
export const PROCESSOR_RETRY_REASONS = [
  // Reused from ingestion's reason codes:
  SCHEMA_REASON_UNSUPPORTED_VERSION,
  SCHEMA_REASON_SUNSET,
  SCHEMA_REASON_UNKNOWN_EVENT,
  SCHEMA_REASON_INVALID_PROPERTIES,
  SCHEMA_REASON_INVALID_ENVELOPE,
  BATCH_REASON_PUBLISH_FAILED,
  BATCH_REASON_INVALID_REQUEST,
  // Processor-specific:
  "decode_failed", // JSON parse failure on consumed payload
  "network_error", // Transient broker / upstream failure
  "transient_failure", // Generic retryable error (timeouts, etc.)
  "unknown_error", // Fallback when no signal pins the cause
] as const;

export type ProcessorRetryReason = (typeof PROCESSOR_RETRY_REASONS)[number];

/**
 * Verdict returned by the classifier. The `retryable` flag is what the
 * runtime branches on; `reason` is what the retry/DLQ message headers and
 * metrics labels carry.
 */
export interface ProcessorRetryClassification {
  /** True if the next attempt should go to the retry topic. */
  readonly retryable: boolean;
  /** Stable machine-readable reason code. */
  readonly reason: ProcessorRetryReason;
  /** Short human-readable note. Truncated for retry/DLQ headers. */
  readonly description: string;
}

/**
 * Classify an error for retry/DLQ routing.
 *
 * The function is intentionally narrow: it inspects the error class name
 * and message and returns a small fixed verdict. Processors that need to
 * widen the classification (e.g. branch on a vendor-specific HTTP status)
 * should wrap this and override the result.
 */
export function classifyError(err: unknown): ProcessorRetryClassification {
  if (err === null || err === undefined) {
    return reason("unknown_error", false, "null/undefined error value");
  }

  if (typeof err === "string") {
    return reason("unknown_error", false, truncate(err));
  }

  if (!(err instanceof Error)) {
    return reason("unknown_error", false, truncate(String(err)));
  }

  const name = err.name;
  const message = err.message;

  // ----------------------------------------------------------------------
  // Decode failures: payload is not valid JSON. Not retryable — replaying
  // the same bytes will fail identically. Route to DLQ for operator
  // inspection (a producer is emitting garbage).
  // ----------------------------------------------------------------------
  if (name === "EventDeserializationError" || /failed to parse .* json/i.test(message)) {
    return reason("decode_failed", false, truncate(message));
  }

  // ----------------------------------------------------------------------
  // Schema-related failures. These are surface-equivalent across the
  // ingester and processors: the payload's shape is wrong. Not retryable.
  // ----------------------------------------------------------------------
  if (name === "ZodError" || /zod/i.test(name)) {
    return reason(SCHEMA_REASON_INVALID_PROPERTIES, false, truncate(message));
  }

  if (/missing required envelope fields|invalid envelope/i.test(message)) {
    return reason(SCHEMA_REASON_INVALID_ENVELOPE, false, truncate(message));
  }
  if (/unsupported.*schema.*version/i.test(message)) {
    return reason(SCHEMA_REASON_UNSUPPORTED_VERSION, false, truncate(message));
  }
  if (/schema.*sunset|sunset_at/i.test(message)) {
    return reason(SCHEMA_REASON_SUNSET, false, truncate(message));
  }
  if (/unknown event/i.test(message)) {
    return reason(SCHEMA_REASON_UNKNOWN_EVENT, false, truncate(message));
  }
  if (/invalid properties/i.test(message)) {
    return reason(SCHEMA_REASON_INVALID_PROPERTIES, false, truncate(message));
  }
  if (/invalid request/i.test(message)) {
    return reason(BATCH_REASON_INVALID_REQUEST, false, truncate(message));
  }

  // ----------------------------------------------------------------------
  // KafkaJS errors. Refer to the `KafkaJSError` class hierarchy: the
  // `.retriable` boolean signals whether KafkaJS itself considers the
  // operation safe to retry. Polaris respects that flag.
  // ----------------------------------------------------------------------
  if (isKafkaJsError(err)) {
    const retriable = readRetriable(err) ?? false;
    if (retriable) {
      return reason("transient_failure", true, truncate(`${name}: ${message}`));
    }
    return reason(BATCH_REASON_PUBLISH_FAILED, false, truncate(`${name}: ${message}`));
  }

  // ----------------------------------------------------------------------
  // Generic Node error names that signal network/transient conditions.
  // ----------------------------------------------------------------------
  if (
    name === "AggregateError" ||
    name === "FetchError" ||
    name === "TimeoutError" ||
    isErrnoNetwork(err)
  ) {
    return reason("network_error", true, truncate(`${name}: ${message}`));
  }

  // ----------------------------------------------------------------------
  // Fallback. We DEFAULT TO retryable for unknown errors: better to absorb
  // a few duplicate replays than to send a transient failure straight to
  // DLQ. Truly permanent failures bubble up after the retry budget and
  // the caller's policy moves them to DLQ then.
  // ----------------------------------------------------------------------
  return reason("unknown_error", true, truncate(`${name}: ${message}`));
}

function reason(
  code: ProcessorRetryReason,
  retryable: boolean,
  description: string,
): ProcessorRetryClassification {
  return { retryable, reason: code, description };
}

function truncate(value: string, max = 512): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

interface MaybeKafkaJsError extends Error {
  readonly retriable?: unknown;
}

function isKafkaJsError(err: Error): err is MaybeKafkaJsError {
  // KafkaJS errors all have a name starting with `KafkaJS*` (e.g.
  // `KafkaJSError`, `KafkaJSProtocolError`). Sniffing the prefix is
  // cheaper than instanceof and avoids importing KafkaJS just to test
  // the class hierarchy.
  return err.name.startsWith("KafkaJS");
}

function readRetriable(err: MaybeKafkaJsError): boolean | undefined {
  const value = err.retriable;
  if (typeof value === "boolean") return value;
  return undefined;
}

interface MaybeErrnoError extends Error {
  readonly code?: unknown;
}

function isErrnoNetwork(err: Error): err is MaybeErrnoError {
  const code = (err as MaybeErrnoError).code;
  if (typeof code !== "string") return false;
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EPIPE" ||
    code === "EAI_AGAIN"
  );
}
