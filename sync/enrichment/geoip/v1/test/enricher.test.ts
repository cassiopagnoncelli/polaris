/**
 * Geo enricher tests.
 *
 * Two things are being protected here. The decision table — the four
 * ways a lookup can end and the provenance each carries — and the
 * privacy posture, which is the reason this enricher exists in the
 * shape it does rather than passing an address straight through.
 */

import { describe, expect, it } from "vitest";

import { enrichGeo } from "../src/enricher.js";
import { hashIp, parseIp } from "../src/ip.js";
import { InMemoryIPLookup, NoOpIPLookup } from "../src/lookup.js";

const DB = new InMemoryIPLookup(
  {
    "8.8.8.8": {
      source: "maxmind:GeoLite2-City:2026-08-01",
      country_code: "US",
      region_code: "CA",
      region_name: "California",
      city: "Mountain View",
    },
    "2001:db8::1": {
      source: "maxmind:GeoLite2-City:2026-08-01",
      country_code: "DE",
      region_name: "Bayern",
    },
  },
  { id: "maxmind:GeoLite2-City:2026-08-01" },
);

describe("geo enrichment", () => {
  it("maps a hit onto the four-field block, keeping the result's provenance", () => {
    const outcome = enrichGeo({ ip: "8.8.8.8", lookup: DB });

    expect(outcome.kind).toBe("hit");
    expect(outcome.geo).toEqual({
      country: "US",
      region: "CA",
      city: "Mountain View",
      // From the RESULT, not the adapter: a database that version-stamps
      // its own answers keeps that provenance through the enricher.
      source: "maxmind:GeoLite2-City:2026-08-01",
    });
  });

  it("falls back to the subdivision name when the record carries no code", () => {
    // Not every country's subdivisions have ISO codes; a region name is
    // better than a null.
    const outcome = enrichGeo({ ip: "2001:db8::1", lookup: DB });
    expect(outcome.geo.region).toBe("Bayern");
    expect(outcome.geo.city).toBeNull();
  });

  it("reports no_ip for an absent or unparseable address", () => {
    for (const ip of [null, undefined, "", "   ", "not-an-ip", 12345, {}]) {
      const outcome = enrichGeo({ ip, lookup: DB });
      expect(outcome.kind, String(ip)).toBe("no_ip");
      expect(outcome.geo.source, String(ip)).toBe("no_ip");
      expect(outcome.ipHash, String(ip)).toBeNull();
    }
  });

  it("distinguishes a wired backend's miss from having no backend", () => {
    // Both produce a null geo, and an operator needs to tell them apart:
    // one is a normal unknown address, the other is a geo outage. The
    // distinction lives in BOTH the source (on the wire) and the kind
    // (countable), because a dashboard cannot read a field it does not
    // aggregate.
    const miss = enrichGeo({ ip: "203.0.113.7", lookup: DB });
    expect(miss.kind).toBe("miss");
    expect(miss.geo.source).toBe("maxmind:GeoLite2-City:2026-08-01");

    const unwired = enrichGeo({ ip: "203.0.113.7", lookup: new NoOpIPLookup() });
    expect(unwired.kind).toBe("no_backend");
    expect(unwired.geo.source).toBe("no_lookup");
  });

  it("always produces a source, so a null geo is never ambiguous", () => {
    for (const ip of [null, "203.0.113.7", "8.8.8.8"]) {
      const outcome = enrichGeo({ ip, lookup: DB });
      expect(outcome.geo.source.length, String(ip)).toBeGreaterThan(0);
    }
  });

  it("never returns the address itself, in any field", () => {
    const outcome = enrichGeo({ ip: "8.8.8.8", lookup: DB });
    const serialised = JSON.stringify(outcome.geo);
    expect(serialised).not.toContain("8.8.8.8");
    expect(serialised).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u);
  });
});

describe("address handling", () => {
  it("hashes to the pinned digest, so the value never silently drifts", () => {
    // Same anchor the legacy processor pinned. If this changes, every
    // log line that referenced an address stops correlating with the
    // ones written before the change.
    expect(hashIp("8.8.8.8")).toBe(
      "838c4c2573848f58e74332341a7ca6bc5cd86a8aec7d644137d53b4d597f10f5",
    );
  });

  it("trims before hashing, so padding does not fork the digest", () => {
    expect(hashIp(parseIp("  8.8.8.8  ") as string)).toBe(hashIp("8.8.8.8"));
  });

  it("does not canonicalise IPv6, keeping the form the event carried", () => {
    // Canonicalising would make `2001:db8::1` and its expanded form hash
    // differently from what the source event holds.
    expect(parseIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    );
    expect(parseIp("fe80::1%eth0")).toBe("fe80::1%eth0");
  });

  it("exposes the hash only as a log reference, never on the block", () => {
    const outcome = enrichGeo({ ip: "8.8.8.8", lookup: DB });
    expect(outcome.ipHash).toBe(hashIp("8.8.8.8"));
    expect(JSON.stringify(outcome.geo)).not.toContain(outcome.ipHash as string);
  });
});
