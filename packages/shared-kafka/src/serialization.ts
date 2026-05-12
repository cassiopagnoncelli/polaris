/**
 * Event serialization helpers.
 *
 * Polaris canonical events are transported on Redpanda as JSON-encoded
 * canonical envelopes. The package keeps the serialization layer thin:
 * encode/decode plus a typed error so callers can decide whether to retry,
 * DLQ, or drop. We do not silently coerce missing fields here — schema
 * validation is the responsibility of `@polaris/shared-schemas`.
 *
 * Buffer is used directly because KafkaJS accepts `string | Buffer` for
 * message values; Buffer is the canonical wire shape.
 */

/**
 * Thrown when a wire payload cannot be parsed into JSON.
 *
 * Schema-level errors (missing fields, wrong types) are not raised here —
 * the caller should run the payload through the envelope/property schemas.
 * This error covers only "the bytes are not even JSON".
 */
export class EventDeserializationError extends Error {
  public override readonly name = "EventDeserializationError";

  public override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Encode a canonical event (or any JSON-serializable value) to a `Buffer`
 * suitable for KafkaJS `message.value`.
 *
 * Callers should pass the post-stamp envelope (with `project_id`,
 * `environment`, `ingested_at`, trusted `source.id`) — this helper is
 * payload-agnostic and does not enforce envelope shape.
 */
export function encodeEvent(event: unknown): Buffer {
  return Buffer.from(JSON.stringify(event), "utf8");
}

/**
 * Decode a wire payload to a JSON value. The runtime shape is `unknown`
 * because schema validation lives in `@polaris/shared-schemas`.
 *
 * Accepts `Buffer`, `string`, or `null` (KafkaJS uses null for tombstones).
 * A null/empty payload returns `null` so callers can branch on tombstones.
 */
export function decodeEvent(payload: Buffer | string | null): unknown {
  if (payload === null) return null;
  if (typeof payload === "string") {
    if (payload.length === 0) return null;
    return parseJson(payload);
  }
  if (payload.length === 0) return null;
  return parseJson(payload.toString("utf8"));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new EventDeserializationError(
      `Failed to parse Polaris event payload as JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    );
  }
}
