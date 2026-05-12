/**
 * Standard Polaris message headers.
 *
 * KafkaJS represents message headers as a `Record<string, string | Buffer |
 * (string | Buffer)[] | undefined>`. Polaris standardizes a small,
 * fixed-shape set of header keys so:
 *
 *   - downstream consumers can route/filter on platform metadata without
 *     re-deserializing the canonical envelope,
 *   - retry/DLQ tooling has enough context to diagnose failures (per
 *     `03-redpanda-topics.md` "Retries and DLQs must include enough metadata
 *     to diagnose source event, processor/consumer version, error class,
 *     attempts, and timestamps"),
 *   - tracing/metrics can be wired without reading the message body.
 *
 * All values are encoded as UTF-8 strings to keep parsing trivial and
 * cross-tool compatible. Numbers are stringified.
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
 * Header bag accepted by KafkaJS producers (mirrors `IHeaders`). We keep our
 * own structural type so downstream code does not have to import KafkaJS for
 * a value-level type that is structurally trivial.
 */
export type MessageHeaders = Record<string, string | Buffer | Array<string | Buffer> | undefined>;

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
