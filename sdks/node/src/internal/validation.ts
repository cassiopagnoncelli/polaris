/**
 * Basic client-side validation per `10-sdk-standards.md`:
 *
 *   SDKs validate:
 *     - event name is a string
 *     - properties is an object
 *     - `occurred_at` is valid if supplied
 *     - batch size limits
 *     - estimated payload size limits
 *     - identity/context shape
 *
 *   SDKs do NOT:
 *     - bundle the full event catalog in v1
 *     - perform authoritative event-specific `properties` validation
 *
 * Anything beyond these "did the caller pass a syntactically reasonable
 * value" checks is the ingester's job. The whole point of these checks is
 * to fail fast on producer bugs (typo'd event name, accidentally passing
 * `undefined` as `properties`) without dragging the canonical event
 * catalog into the SDK distribution.
 */

// The `/envelope` subpath, not the package root: the root barrel re-exports
// the file-backed catalog loader (`node:fs`, `yaml`), which every bundler
// then drags into a deployment artifact that has no use for it.
import { eventNameRegex } from "@polaris/spec/envelope";

export class ValidationError extends Error {
  public override readonly name = "ValidationError";
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Validate a track() event name. Throws `ValidationError` on failure. */
export function assertValidEventName(event: unknown): asserts event is string {
  if (typeof event !== "string" || event.length === 0) {
    throw new ValidationError("invalid_event_name", "event must be a non-empty string");
  }
  if (event.length > 128) {
    throw new ValidationError("invalid_event_name", "event name exceeds 128 characters");
  }
  if (!eventNameRegex.test(event)) {
    throw new ValidationError(
      "invalid_event_name",
      "event name must be lowercase snake_case segments joined by dots, with at least two segments",
    );
  }
}

/** Validate properties is a plain object (allow `undefined`, treat as `{}`). */
export function assertValidProperties(
  properties: unknown,
): asserts properties is Record<string, unknown> | undefined {
  if (properties === undefined) return;
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties) ||
    Object.getPrototypeOf(properties) !== Object.prototype
  ) {
    throw new ValidationError(
      "invalid_properties",
      "properties must be a plain object (or undefined)",
    );
  }
}

/** Validate occurred_at if supplied. */
export function normalizeOccurredAt(occurredAt: Date | string | undefined): string {
  if (occurredAt === undefined) return new Date().toISOString();
  if (occurredAt instanceof Date) {
    if (Number.isNaN(occurredAt.getTime())) {
      throw new ValidationError("invalid_occurred_at", "occurredAt Date is invalid");
    }
    return occurredAt.toISOString();
  }
  if (typeof occurredAt === "string") {
    const parsed = new Date(occurredAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError("invalid_occurred_at", "occurredAt string is not parseable");
    }
    return parsed.toISOString();
  }
  throw new ValidationError("invalid_occurred_at", "occurredAt must be a Date or ISO string");
}

/** Validate a schema_version override if supplied. */
export function normalizeSchemaVersion(version: number | undefined): number {
  if (version === undefined) return 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("invalid_schema_version", "schemaVersion must be a positive integer");
  }
  return version;
}

/** Customer ID input validation for `identify()`. */
export function assertValidCustomerId(customerId: unknown): asserts customerId is string {
  if (typeof customerId !== "string" || customerId.length === 0) {
    throw new ValidationError("invalid_customer_id", "customerId must be a non-empty string");
  }
  if (customerId.length > 128) {
    throw new ValidationError("invalid_customer_id", "customerId exceeds 128 characters");
  }
}
