import { type Envelope, envelopeSchema } from "../envelope/envelope.js";
import {
  SCHEMA_REASON_INVALID_ENVELOPE,
  SCHEMA_REASON_INVALID_PROPERTIES,
  SCHEMA_REASON_SUNSET,
  SCHEMA_REASON_UNKNOWN_EVENT,
  SCHEMA_REASON_UNSUPPORTED_VERSION,
  type SchemaReasonCode,
} from "../reason-codes.js";
import type { EventCatalog } from "./loader.js";

/**
 * Result of validating one event against the envelope schema and the
 * registered catalog. Used by the ingester (P2-003) to build per-event
 * batch responses, and by unit tests in this package to exercise the
 * reason-code shapes.
 */
export type CatalogValidationResult =
  | {
      ok: true;
      event: Envelope;
      /** True when the event was accepted but uses a deprecated schema_version. */
      deprecated: boolean;
    }
  | {
      ok: false;
      code: SchemaReasonCode;
      /** Structured detail surfaced inside the batch response. Never echoes redacted values. */
      detail?: {
        event?: string;
        schema_version?: number;
        sunset_at?: string;
        supported_versions?: number[];
        path?: Array<string | number>;
        message?: string;
      };
    };

/**
 * Validate an arbitrary payload against the canonical envelope and the
 * catalog-registered properties schema. Returns a discriminated result so
 * callers can map directly to per-event batch entries without further
 * branching on errors.
 *
 * `now` is parameterized so tests and replay flows can reason about
 * sunset boundaries deterministically.
 */
export function validateCatalogEvent(
  payload: unknown,
  catalog: EventCatalog,
  options: { now?: Date } = {},
): CatalogValidationResult {
  const now = options.now ?? new Date();

  const envelopeResult = envelopeSchema.safeParse(payload);
  if (!envelopeResult.success) {
    const firstIssue = envelopeResult.error.issues[0];
    return {
      ok: false,
      code: SCHEMA_REASON_INVALID_ENVELOPE,
      detail: {
        path: firstIssue ? firstIssue.path.map(toPathSegment) : [],
        message: firstIssue?.message ?? "envelope failed validation",
      },
    };
  }

  const envelope = envelopeResult.data;

  const versions = catalog.getVersions(envelope.event);
  if (versions.length === 0) {
    return {
      ok: false,
      code: SCHEMA_REASON_UNKNOWN_EVENT,
      detail: { event: envelope.event },
    };
  }

  const entry = catalog.getEntry(envelope.event, envelope.schema_version);
  if (!entry) {
    return {
      ok: false,
      code: SCHEMA_REASON_UNSUPPORTED_VERSION,
      detail: {
        event: envelope.event,
        schema_version: envelope.schema_version,
        supported_versions: versions.map((v) => v.schema_version),
      },
    };
  }

  if (catalog.isSunset(envelope.event, envelope.schema_version, now)) {
    return {
      ok: false,
      code: SCHEMA_REASON_SUNSET,
      detail: {
        event: envelope.event,
        schema_version: envelope.schema_version,
        ...(entry.sunset_at !== undefined ? { sunset_at: entry.sunset_at } : {}),
        supported_versions: catalog
          .getVersions(envelope.event)
          .filter((v) => !catalog.isSunset(v.name, v.schema_version, now))
          .map((v) => v.schema_version),
      },
    };
  }

  const propertiesResult = entry.propertiesSchema.safeParse(envelope.properties);
  if (!propertiesResult.success) {
    const firstIssue = propertiesResult.error.issues[0];
    return {
      ok: false,
      code: SCHEMA_REASON_INVALID_PROPERTIES,
      detail: {
        event: envelope.event,
        schema_version: envelope.schema_version,
        path: firstIssue ? ["properties", ...firstIssue.path.map(toPathSegment)] : ["properties"],
        message: firstIssue?.message ?? "properties failed validation",
      },
    };
  }

  return {
    ok: true,
    event: envelope,
    deprecated: entry.lifecycle === "deprecated",
  };
}

function toPathSegment(segment: PropertyKey): string | number {
  return typeof segment === "number" ? segment : String(segment);
}
