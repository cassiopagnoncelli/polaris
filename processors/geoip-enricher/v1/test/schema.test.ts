/**
 * Schema-binding tests.
 *
 * Confirm that the canonical envelope built by `buildGeoipEnvelope`
 * (via the runtime) passes the Zod properties schema published in
 * `@polaris/shared-schemas`. This is the integration contract between
 * the enricher's emit module and the platform catalog:
 *
 *   - the schema's `.strict()` shape rejects unknown fields,
 *   - the schema's regex on `source` accepts the runtime literals
 *     (`"no_ip"`, `"no_lookup"`, `"in_memory:..."`).
 *
 * If the emit module ever drifts from the schema, these tests fail.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enrichedGeoipV1PropertiesSchema } from "@polaris/shared-schemas";
import { describe, expect, it } from "vitest";

import {
  decideEnrichment,
  decisionToProperties,
  fromFixture,
  type GeoResult,
  NoOpIPLookup,
} from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, "fixtures", "geoip-sample.json");

function loadFixture(): Record<string, GeoResult> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, GeoResult>;
}

describe("enrichedGeoipV1PropertiesSchema", () => {
  it("accepts the runtime payload for a known IPv4", () => {
    const lookup = fromFixture(loadFixture());
    const properties = decisionToProperties(decideEnrichment({ ip: "8.8.8.8", lookup }), {
      source_event_id: "evt_123",
      run_id: "run_456",
    });
    const parsed = enrichedGeoipV1PropertiesSchema.safeParse(properties);
    expect(parsed.success).toBe(true);
  });

  it("accepts the runtime payload for a known IPv6", () => {
    const lookup = fromFixture(loadFixture());
    const properties = decisionToProperties(decideEnrichment({ ip: "2001:db8::1", lookup }), {
      source_event_id: "evt_123",
      run_id: "run_456",
    });
    const parsed = enrichedGeoipV1PropertiesSchema.safeParse(properties);
    expect(parsed.success).toBe(true);
  });

  it("accepts the NoOpIPLookup fail-open payload (all-null geo)", () => {
    const properties = decisionToProperties(
      decideEnrichment({ ip: "8.8.8.8", lookup: new NoOpIPLookup() }),
      { source_event_id: "evt_123", run_id: "run_456" },
    );
    const parsed = enrichedGeoipV1PropertiesSchema.safeParse(properties);
    expect(parsed.success).toBe(true);
  });

  it("accepts the no-ip payload (null hash, null geo)", () => {
    const lookup = fromFixture(loadFixture());
    const properties = decisionToProperties(decideEnrichment({ ip: undefined, lookup }), {
      source_event_id: "evt_123",
      run_id: "run_456",
    });
    const parsed = enrichedGeoipV1PropertiesSchema.safeParse(properties);
    expect(parsed.success).toBe(true);
  });

  it("rejects payloads with an unexpected extra field", () => {
    const lookup = fromFixture(loadFixture());
    const base = decisionToProperties(decideEnrichment({ ip: "8.8.8.8", lookup }), {
      source_event_id: "evt_123",
      run_id: "run_456",
    });
    const polluted = { ...base, surprise: "field" };
    const parsed = enrichedGeoipV1PropertiesSchema.safeParse(polluted);
    expect(parsed.success).toBe(false);
  });
});
