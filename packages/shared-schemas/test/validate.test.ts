import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  defaultSchemaBindings,
  loadCatalogFromDir,
  validateCatalogEvent,
} from "../src/catalog/index.js";
import {
  SCHEMA_REASON_INVALID_ENVELOPE,
  SCHEMA_REASON_INVALID_PROPERTIES,
  SCHEMA_REASON_SUNSET,
  SCHEMA_REASON_UNKNOWN_EVENT,
  SCHEMA_REASON_UNSUPPORTED_VERSION,
  schemaRejectionSchema,
} from "../src/reason-codes.js";
import { checkoutStartedV1Fixture, pageViewedV1Fixture, pageViewedV2Fixture } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = resolve(__dirname, "..", "..", "..", "catalog", "events");
const catalog = loadCatalogFromDir(CATALOG_ROOT, defaultSchemaBindings);

/** Moment before page.viewed v1's sunset_at (2026-08-10T00:00:00Z). */
const PRE_SUNSET = new Date("2026-05-12T00:00:00Z");
/** Moment after page.viewed v1's sunset_at. */
const POST_SUNSET = new Date("2026-08-10T00:00:01Z");

describe("validateCatalogEvent — happy paths", () => {
  it("accepts a valid active event (v2)", () => {
    const result = validateCatalogEvent(pageViewedV2Fixture, catalog, { now: PRE_SUNSET });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deprecated).toBe(false);
      expect(result.event.event).toBe("page.viewed");
      expect(result.event.schema_version).toBe(2);
    }
  });

  it("accepts a valid deprecated event before sunset and flags it", () => {
    const result = validateCatalogEvent(pageViewedV1Fixture, catalog, { now: PRE_SUNSET });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deprecated).toBe(true);
    }
  });

  it("accepts a valid checkout.started v1 event", () => {
    const result = validateCatalogEvent(checkoutStartedV1Fixture, catalog, { now: PRE_SUNSET });
    expect(result.ok).toBe(true);
  });
});

describe("validateCatalogEvent — reason codes", () => {
  it("returns schema_version_sunset after the sunset_at moment", () => {
    const result = validateCatalogEvent(pageViewedV1Fixture, catalog, { now: POST_SUNSET });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SCHEMA_REASON_SUNSET);
      expect(result.detail?.event).toBe("page.viewed");
      expect(result.detail?.schema_version).toBe(1);
      expect(result.detail?.sunset_at).toBe("2026-08-10T00:00:00Z");
      // supported_versions reflects what producers should migrate to
      expect(result.detail?.supported_versions).toEqual([2]);
    }
  });

  it("returns unsupported_schema_version for an unknown version of a known event", () => {
    const result = validateCatalogEvent({ ...pageViewedV2Fixture, schema_version: 99 }, catalog, {
      now: PRE_SUNSET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SCHEMA_REASON_UNSUPPORTED_VERSION);
      expect(result.detail?.event).toBe("page.viewed");
      expect(result.detail?.schema_version).toBe(99);
      expect(result.detail?.supported_versions).toEqual([1, 2]);
    }
  });

  it("returns unknown_event when the event name is not registered", () => {
    const result = validateCatalogEvent(
      { ...pageViewedV2Fixture, event: "marketing.unregistered" },
      catalog,
      { now: PRE_SUNSET },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SCHEMA_REASON_UNKNOWN_EVENT);
      expect(result.detail?.event).toBe("marketing.unregistered");
    }
  });

  it("returns invalid_envelope when a top-level field is wrong-typed", () => {
    const result = validateCatalogEvent(
      { ...pageViewedV2Fixture, event_id: "not-a-uuid" },
      catalog,
      { now: PRE_SUNSET },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SCHEMA_REASON_INVALID_ENVELOPE);
    }
  });

  it("returns invalid_envelope on an unknown top-level field", () => {
    const result = validateCatalogEvent({ ...pageViewedV2Fixture, extra: "no" }, catalog, {
      now: PRE_SUNSET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SCHEMA_REASON_INVALID_ENVELOPE);
    }
  });

  it("returns invalid_properties when properties fail their versioned schema", () => {
    const result = validateCatalogEvent(
      {
        ...pageViewedV2Fixture,
        // Missing required referrer (v2)
        properties: { path: "/x", search: null, title: "x" },
      },
      catalog,
      { now: PRE_SUNSET },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(SCHEMA_REASON_INVALID_PROPERTIES);
      expect(result.detail?.path?.[0]).toBe("properties");
    }
  });
});

describe("SchemaRejection shape (consumer of reason codes)", () => {
  // The shape of the rejection record consumers (ingester, SDK) receive
  // is asserted here so future refactors keep the wire format stable.
  it("conforms to schemaRejectionSchema for an unsupported version", () => {
    const result = validateCatalogEvent({ ...pageViewedV2Fixture, schema_version: 99 }, catalog, {
      now: PRE_SUNSET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const parsed = schemaRejectionSchema.safeParse({
        event_id: pageViewedV2Fixture.event_id,
        code: result.code,
        detail: result.detail,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("conforms to schemaRejectionSchema for a sunset version", () => {
    const result = validateCatalogEvent(pageViewedV1Fixture, catalog, { now: POST_SUNSET });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const parsed = schemaRejectionSchema.safeParse({
        event_id: pageViewedV1Fixture.event_id,
        code: result.code,
        detail: result.detail,
      });
      expect(parsed.success).toBe(true);
    }
  });
});
