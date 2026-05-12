/**
 * Basic client-side validation for the Web SDK.
 *
 * Per `docs/architecture/10-sdk-standards.md` § Client-Side Validation:
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
 *     - decide whether an event is governed or experimental
 *
 * The Web SDK keeps a local copy of these helpers — the Node SDK ships
 * the same checks — because the Node SDK package would drag Node-only
 * code into a browser bundle if we shared it.
 */

import { eventNameRegex } from "@polaris/shared-schemas";
import type { EventPriority } from "../types.js";

export class ValidationError extends Error {
  public override readonly name = "ValidationError";
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Validate a `track()` event name. */
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

/** Validate `properties` is a plain object (allow `undefined`, treated as `{}`). */
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

/** Validate `schema_version`. */
export function normalizeSchemaVersion(version: number | undefined): number {
  if (version === undefined) return 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("invalid_schema_version", "schemaVersion must be a positive integer");
  }
  return version;
}

/** Validate (and default) the `priority` parameter on `track()`. */
export function normalizePriority(priority: unknown): EventPriority {
  if (priority === undefined) return "normal";
  if (priority !== "low" && priority !== "normal" && priority !== "high") {
    throw new ValidationError("invalid_priority", "priority must be 'low', 'normal', or 'high'");
  }
  return priority;
}
