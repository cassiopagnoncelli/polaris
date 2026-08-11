/**
 * Standard Polaris message headers.
 *
 * Polaris standardizes a small, fixed-shape set of header keys so:
 *
 *   - downstream consumers can route/filter on platform metadata without
 *     re-deserializing the canonical envelope,
 *   - retry/DLQ tooling has enough context to diagnose failures (per
 *     `03-rabbitmq-streams.md` "Retries and DLQs must include enough
 *     metadata to diagnose source event, processor/consumer version, error
 *     class, attempts, and timestamps"),
 *   - tracing/metrics can be wired without reading the message body.
 *
 * All values are encoded as UTF-8 strings to keep parsing trivial and
 * cross-tool compatible. Numbers are stringified. They travel in the AMQP
 * `headers` property table; `toAmqpHeaders` / `fromAmqpHeaders` below are
 * the only place that conversion happens.
 *
 * **The key names are a wire contract and did not change with the move off
 * Kafka.** `polaris-topic-family` and `polaris-source-topic` still say
 * "topic": messages produced before the migration must stay readable by
 * post-migration consumers (and by replay tooling reading 90-day-old
 * streams), and the envelope contract in `01-event-contract.md` names
 * them. They carry stream names now.
 */

/** Header key constants. Centralised here so producer + consumer agree. */
export const POLARIS_HEADER_EVENT_ID = "polaris-event-id";
export const POLARIS_HEADER_EVENT_NAME = "polaris-event-name";
export const POLARIS_HEADER_SCHEMA_VERSION = "polaris-schema-version";
export const POLARIS_HEADER_PROJECT_ID = "polaris-project-id";
export const POLARIS_HEADER_ENVIRONMENT = "polaris-environment";
export const POLARIS_HEADER_SOURCE_ID = "polaris-source-id";
export const POLARIS_HEADER_TOPIC_FAMILY = "polaris-topic-family";
export const POLARIS_HEADER_PRODUCER = "polaris-producer";
export const POLARIS_HEADER_PRODUCER_VERSION = "polaris-producer-version";
export const POLARIS_HEADER_CONTENT_TYPE = "polaris-content-type";
export const POLARIS_HEADER_INGESTED_AT = "polaris-ingested-at";
export const POLARIS_HEADER_OCCURRED_AT = "polaris-occurred-at";

/** Retry / DLQ-specific headers. Present on retry and DLQ topics only. */
export const POLARIS_HEADER_RETRY_ATTEMPTS = "polaris-retry-attempts";
export const POLARIS_HEADER_RETRY_REASON = "polaris-retry-reason";
export const POLARIS_HEADER_ERROR_CLASS = "polaris-error-class";
export const POLARIS_HEADER_ERROR_MESSAGE = "polaris-error-message";
export const POLARIS_HEADER_FAILED_AT = "polaris-failed-at";
export const POLARIS_HEADER_SOURCE_TOPIC = "polaris-source-topic";
export const POLARIS_HEADER_SOURCE_PARTITION = "polaris-source-partition";
export const POLARIS_HEADER_SOURCE_OFFSET = "polaris-source-offset";

/** Default content-type tag for JSON-serialized canonical events. */
export const POLARIS_CONTENT_TYPE_JSON = "application/json;charset=utf-8";

/**
 * Polaris header bag. Structural on purpose: no driver type leaks into
 * service code, and the shape is permissive enough to hold what a broker
 * hands back (AMQP long-strings decode as `string`, but a publisher may
 * have written raw bytes).
 */
export type MessageHeaders = Record<string, string | Buffer | Array<string | Buffer> | undefined>;

/**
 * AMQP property-table shape. amqplib accepts `any` here; this alias keeps
 * the driver's intent legible without pulling amqplib types into modules
 * that only care about headers.
 */
export type AmqpHeaders = Record<string, unknown>;

/**
 * Project a Polaris header bag onto an AMQP property table.
 *
 * Everything is normalized to UTF-8 strings: AMQP field tables carry typed
 * values, and letting Buffers through would mean the same header decodes
 * as `Buffer` on one hop and `string` on the next. Arrays are joined with
 * `,` — Polaris never emits multi-value headers, but a foreign publisher
 * might, and dropping the value silently would be worse.
 */
export function toAmqpHeaders(headers: MessageHeaders | undefined): AmqpHeaders {
  const out: AmqpHeaders = {};
  if (headers === undefined) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      out[key] = value;
    } else if (Buffer.isBuffer(value)) {
      out[key] = value.toString("utf8");
    } else if (Array.isArray(value)) {
      out[key] = value
        .map((entry) => (Buffer.isBuffer(entry) ? entry.toString("utf8") : entry))
        .join(",");
    }
  }
  return out;
}

/**
 * Project an AMQP property table back onto a Polaris header bag.
 *
 * Non-string scalars (RabbitMQ's own `x-` headers are frequently numbers,
 * and `x-death` is an array of tables) are stringified so
 * `readHeaderString` behaves uniformly. Nested tables are JSON-encoded
 * rather than dropped so DLQ triage can still see `x-death` counts.
 */
export function fromAmqpHeaders(headers: AmqpHeaders | undefined): MessageHeaders {
  const out: MessageHeaders = {};
  if (headers === undefined || headers === null) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      out[key] = value;
    } else if (Buffer.isBuffer(value)) {
      out[key] = value.toString("utf8");
    } else if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      out[key] = String(value);
    } else {
      try {
        out[key] = JSON.stringify(value);
      } catch {
        // A value that cannot be serialized (cyclic table) is dropped
        // rather than failing the whole delivery.
      }
    }
  }
  return out;
}

/**
 * Platform metadata that every produced canonical-event message must carry.
 *
 * `event_id`, `event_name`, `schema_version`, `project_id`, `environment`,
 * and timestamps come from the canonical envelope. `source_id`, `producer`,
 * `producer_version`, and `topic_family` are added by the producing
 * component (ingester, processor, consumer) and never come from the wire.
 */
export interface PolarisHeaderInput {
  readonly event_id: string;
  readonly event_name: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at?: string | undefined;
  readonly source_id?: string | undefined;
  readonly producer: string;
  readonly producer_version?: string | undefined;
  readonly topic_family: string;
  readonly content_type?: string | undefined;
}

/**
 * Retry/DLQ envelope metadata. The header serializer copies the original
 * platform headers plus this failure context so an operator can replay or
 * triage without consulting the source topic.
 */
export interface RetryHeaderInput {
  readonly attempts: number;
  readonly reason: string;
  readonly error_class?: string | undefined;
  readonly error_message?: string | undefined;
  readonly failed_at: string;
  readonly source_topic: string;
  readonly source_partition?: number | undefined;
  readonly source_offset?: string | undefined;
}

/**
 * Build the canonical header bag for an outgoing event message.
 */
export function buildEventHeaders(input: PolarisHeaderInput): MessageHeaders {
  const headers: MessageHeaders = {
    [POLARIS_HEADER_EVENT_ID]: input.event_id,
    [POLARIS_HEADER_EVENT_NAME]: input.event_name,
    [POLARIS_HEADER_SCHEMA_VERSION]: String(input.schema_version),
    [POLARIS_HEADER_PROJECT_ID]: input.project_id,
    [POLARIS_HEADER_ENVIRONMENT]: input.environment,
    [POLARIS_HEADER_OCCURRED_AT]: input.occurred_at,
    [POLARIS_HEADER_TOPIC_FAMILY]: input.topic_family,
    [POLARIS_HEADER_PRODUCER]: input.producer,
    [POLARIS_HEADER_CONTENT_TYPE]: input.content_type ?? POLARIS_CONTENT_TYPE_JSON,
  };
  if (input.ingested_at !== undefined) {
    headers[POLARIS_HEADER_INGESTED_AT] = input.ingested_at;
  }
  if (input.source_id !== undefined) {
    headers[POLARIS_HEADER_SOURCE_ID] = input.source_id;
  }
  if (input.producer_version !== undefined) {
    headers[POLARIS_HEADER_PRODUCER_VERSION] = input.producer_version;
  }
  return headers;
}

/**
 * Build headers for a retry/DLQ republish. Callers typically merge the
 * returned bag with the original event headers using `mergeHeaders`.
 */
export function buildRetryHeaders(input: RetryHeaderInput): MessageHeaders {
  const headers: MessageHeaders = {
    [POLARIS_HEADER_RETRY_ATTEMPTS]: String(input.attempts),
    [POLARIS_HEADER_RETRY_REASON]: input.reason,
    [POLARIS_HEADER_FAILED_AT]: input.failed_at,
    [POLARIS_HEADER_SOURCE_TOPIC]: input.source_topic,
  };
  if (input.error_class !== undefined) {
    headers[POLARIS_HEADER_ERROR_CLASS] = input.error_class;
  }
  if (input.error_message !== undefined) {
    headers[POLARIS_HEADER_ERROR_MESSAGE] = input.error_message;
  }
  if (input.source_partition !== undefined) {
    headers[POLARIS_HEADER_SOURCE_PARTITION] = String(input.source_partition);
  }
  if (input.source_offset !== undefined) {
    headers[POLARIS_HEADER_SOURCE_OFFSET] = input.source_offset;
  }
  return headers;
}

/**
 * Decode a header value to a UTF-8 string. Returns undefined when the header
 * is missing or has an unexpected shape (arrays are not used by Polaris).
 *
 * Use the typed `read*` helpers below for known platform headers.
 */
export function readHeaderString(
  headers: MessageHeaders | undefined,
  key: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const value = headers[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

/** Read a numeric header value. Returns undefined when missing or unparsable. */
export function readHeaderNumber(
  headers: MessageHeaders | undefined,
  key: string,
): number | undefined {
  const raw = readHeaderString(headers, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

/**
 * Combine multiple header bags. Later sources win on key collision. Useful
 * for retry/DLQ republishes where the platform headers from the original
 * message are preserved and overlaid with the failure-context headers.
 */
export function mergeHeaders(
  ...sources: ReadonlyArray<MessageHeaders | undefined>
): MessageHeaders {
  const out: MessageHeaders = {};
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      out[key] = value;
    }
  }
  return out;
}
