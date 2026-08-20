import { v7 as uuidv7 } from "uuid";

/**
 * Header that callers should set when they want their own request ID
 * propagated end-to-end. Lower-cased because Fastify normalises headers.
 *
 * The bootstrap accepts an incoming value when it is well-formed (RFC 4122
 * UUID shape), otherwise it generates a fresh UUIDv7. This keeps logs from
 * external clients linkable without exposing the platform to garbage input
 * pollution.
 */
export const REQUEST_ID_HEADER = "x-request-id" as const;

/**
 * Polaris-branded alias for the request ID header. Some operators prefer
 * the `polaris` prefix to make trace IDs visibly platform-owned. Either
 * header is accepted; `x-polaris-request-id` wins when both are set.
 */
export const POLARIS_REQUEST_ID_HEADER = "x-polaris-request-id" as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generate a fresh UUIDv7 string suitable for use as a `request_id`.
 *
 * UUIDv7 is used because it is time-ordered: log/metric storage that
 * indexes on the request ID benefits from monotonic clustering, and
 * operators triaging a window of activity can sort by ID and approximate
 * occurrence order without joining against `time`.
 */
export function newRequestId(): string {
  return uuidv7();
}

/**
 * Best-effort normalisation of a caller-supplied request ID header.
 *
 * - returns the trimmed value when it matches RFC 4122 UUID shape
 * - returns `undefined` otherwise so the caller generates a fresh one
 *
 * The pattern accepts any UUID version because external callers may be
 * generating v4 IDs while their proxies set this header. The internal
 * generator always emits v7.
 */
export function normalizeIncomingRequestId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!UUID_PATTERN.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

/**
 * Pick the request ID for an incoming request. Prefers a Polaris-branded
 * header, falls back to the standard `X-Request-Id` header, and finally
 * generates a fresh UUIDv7 when no usable value was supplied.
 */
export function resolveRequestId(headers: Readonly<Record<string, unknown>>): string {
  const polaris = normalizeIncomingRequestId(headers[POLARIS_REQUEST_ID_HEADER]);
  if (polaris !== undefined) return polaris;
  const generic = normalizeIncomingRequestId(headers[REQUEST_ID_HEADER]);
  if (generic !== undefined) return generic;
  return newRequestId();
}
