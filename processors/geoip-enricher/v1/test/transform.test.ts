/**
 * Pure-transform tests for geoip-enricher v1.
 *
 * Cover the three terminal `source` branches of `decideEnrichment` plus
 * the IP parsing / hashing helpers:
 *
 *   - valid IP → InMemoryIPLookup hit  → backend-stamped source
 *   - valid IP → NoOpIPLookup miss     → source = "no_lookup"
 *   - invalid / missing IP             → source = "no_ip", hash null
 *
 * The transform is pure, so the assertions are byte-for-byte. The
 * idempotency case (replay yields identical bytes) is exercised here
 * because the transform owns the determinism contract; the runtime
 * just wires the result onto an envelope.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryIPLookup,
  NoOpIPLookup,
  decideEnrichment,
  decisionToProperties,
  fromFixture,
  hashIp,
  parseIp,
  SOURCE_NO_IP,
  SOURCE_NO_LOOKUP,
  type GeoResult,
} from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, "fixtures", "geoip-sample.json");

function loadFixture(): Record<string, GeoResult> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, GeoResult>;
}

describe("parseIp", () => {
  it("accepts a valid IPv4 address", () => {
    expect(parseIp("8.8.8.8")).toBe("8.8.8.8");
  });

  it("accepts a valid IPv6 address", () => {
    expect(parseIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(parseIp("  8.8.8.8  ")).toBe("8.8.8.8");
  });

  it("returns null for non-string input", () => {
    expect(parseIp(undefined)).toBeNull();
    expect(parseIp(null)).toBeNull();
    expect(parseIp(12345)).toBeNull();
    expect(parseIp({})).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseIp("")).toBeNull();
    expect(parseIp("   ")).toBeNull();
  });

  it("returns null for malformed addresses", () => {
    expect(parseIp("not.an.ip")).toBeNull();
    expect(parseIp("999.999.999.999")).toBeNull();
    expect(parseIp("2001:zz::1")).toBeNull();
  });
});

describe("hashIp", () => {
  it("returns a 64-character lowercase hex SHA-256", () => {
    const hash = hashIp("8.8.8.8");
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    // Pre-computed SHA-256("8.8.8.8") so the hash never silently drifts.
    expect(hash).toBe("838c4c2573848f58e74332341a7ca6bc5cd86a8aec7d644137d53b4d597f10f5");
  });

  it("is deterministic for the same input", () => {
    expect(hashIp("8.8.8.8")).toBe(hashIp("8.8.8.8"));
  });

  it("produces different digests for different IPs", () => {
    expect(hashIp("8.8.8.8")).not.toBe(hashIp("8.8.4.4"));
  });
});

describe("decideEnrichment", () => {
  it("hits the InMemoryIPLookup for a known IPv4 and returns the geo result", () => {
    const lookup = fromFixture(loadFixture());
    const decision = decideEnrichment({ ip: "8.8.8.8", lookup });
    expect(decision.source).toBe("in_memory:test-fixture");
    expect(decision.country_code).toBe("US");
    expect(decision.country_name).toBe("United States");
    expect(decision.region_code).toBe("US-CA");
    expect(decision.region_name).toBe("California");
    expect(decision.city).toBe("Mountain View");
    expect(decision.latitude).toBeCloseTo(37.422, 3);
    expect(decision.longitude).toBeCloseTo(-122.084, 3);
    expect(decision.timezone).toBe("America/Los_Angeles");
    expect(decision.accuracy_radius_km).toBe(1000);
    // Hash must be the SHA-256 of "8.8.8.8".
    expect(decision.source_ip_hash).toBe(hashIp("8.8.8.8"));
  });

  it("hits the InMemoryIPLookup for a known IPv6 and returns the geo result", () => {
    const lookup = fromFixture(loadFixture());
    const decision = decideEnrichment({ ip: "2001:db8::1", lookup });
    expect(decision.country_code).toBe("DE");
    expect(decision.city).toBe("Berlin");
    expect(decision.source_ip_hash).toBe(hashIp("2001:db8::1"));
  });

  it("returns source = 'no_lookup' for the NoOpIPLookup", () => {
    const decision = decideEnrichment({ ip: "8.8.8.8", lookup: new NoOpIPLookup() });
    expect(decision.source).toBe(SOURCE_NO_LOOKUP);
    expect(decision.country_code).toBeNull();
    expect(decision.country_name).toBeNull();
    expect(decision.region_code).toBeNull();
    expect(decision.city).toBeNull();
    expect(decision.latitude).toBeNull();
    expect(decision.longitude).toBeNull();
    expect(decision.timezone).toBeNull();
    expect(decision.accuracy_radius_km).toBeNull();
    // The IP itself was valid, so the hash is populated.
    expect(decision.source_ip_hash).toBe(hashIp("8.8.8.8"));
  });

  it("returns source = 'no_ip' and null hash when the context has no IP", () => {
    const lookup = fromFixture(loadFixture());
    const decision = decideEnrichment({ ip: undefined, lookup });
    expect(decision.source).toBe(SOURCE_NO_IP);
    expect(decision.source_ip_hash).toBeNull();
    expect(decision.country_code).toBeNull();
  });

  it("returns source = 'no_ip' and null hash when the IP is unparseable", () => {
    const lookup = fromFixture(loadFixture());
    const decision = decideEnrichment({ ip: "not-an-ip", lookup });
    expect(decision.source).toBe(SOURCE_NO_IP);
    expect(decision.source_ip_hash).toBeNull();
  });

  it("returns the backend id for a valid IP that the backend doesn't know", () => {
    // InMemoryIPLookup with a unique id; lookup misses → source uses the
    // backend's id rather than the SOURCE_NO_LOOKUP literal.
    const lookup = new InMemoryIPLookup([], { id: "in_memory:smoke" });
    const decision = decideEnrichment({ ip: "8.8.8.8", lookup });
    expect(decision.source).toBe("in_memory:smoke");
    expect(decision.source_ip_hash).toBe(hashIp("8.8.8.8"));
    expect(decision.country_code).toBeNull();
  });

  it("is idempotent: replaying the same input yields byte-identical output", () => {
    const lookup = fromFixture(loadFixture());
    const a = decideEnrichment({ ip: "8.8.8.8", lookup });
    const b = decideEnrichment({ ip: "8.8.8.8", lookup });
    expect(a).toEqual(b);
    // And byte-identical when serialised, which is the property
    // downstream Kafka producers rely on for replay.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("decisionToProperties", () => {
  it("composes the canonical enriched.geoip v1 properties payload", () => {
    const lookup = fromFixture(loadFixture());
    const decision = decideEnrichment({ ip: "8.8.8.8", lookup });
    const properties = decisionToProperties(decision, {
      source_event_id: "evt_123",
      run_id: "run_456",
    });
    expect(properties.source_event_id).toBe("evt_123");
    expect(properties.run_id).toBe("run_456");
    expect(properties.source).toBe("in_memory:test-fixture");
    expect(properties.country_code).toBe("US");
    expect(properties.source_ip_hash).toBe(hashIp("8.8.8.8"));
  });
});
