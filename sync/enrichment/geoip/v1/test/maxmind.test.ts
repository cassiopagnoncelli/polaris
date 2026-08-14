/**
 * MaxMind adapter tests.
 *
 * The record mapping is tested directly, because it is where the
 * decisions are and because the alternative — a real GeoLite2 database —
 * is 60 MB, license-restricted, and cannot live in a repository.
 *
 * The open path is tested against the real filesystem, since its whole
 * job is reacting to what is actually on disk: an absent file and a file
 * that is present but is not a database are the two failure modes an
 * operator hits (a not-yet-provisioned mount, and a truncated or
 * error-page download saved under the .mmdb name).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CityResponse } from "mmdb-lib";
import { describe, expect, it } from "vitest";

import { mapCityResponse, openMaxmindLookup } from "../src/maxmind.js";

const SOURCE = "maxmind:GeoLite2-City:2026-08-01";

describe("mapping a City record", () => {
  it("takes country, subdivision code and city, in English", () => {
    const record = {
      country: { geoname_id: 1, iso_code: "US", names: { en: "United States" } },
      subdivisions: [{ geoname_id: 2, iso_code: "CA", names: { en: "California" } }],
      city: { geoname_id: 3, names: { en: "Mountain View" } },
    } as unknown as CityResponse;

    expect(mapCityResponse(record, SOURCE)).toEqual({
      source: SOURCE,
      country_code: "US",
      region_code: "CA",
      region_name: "California",
      city: "Mountain View",
    });
  });

  it("falls back to registered_country when no located country is present", () => {
    // Satellite and some mobile ranges are placed by registration, and
    // the registered country is the only one such a record carries.
    const record = {
      registered_country: { geoname_id: 4, iso_code: "SE", names: { en: "Sweden" } },
    } as unknown as CityResponse;

    expect(mapCityResponse(record, SOURCE)?.country_code).toBe("SE");
  });

  it("takes the first subdivision, which is the coarsest", () => {
    const record = {
      country: { geoname_id: 1, iso_code: "GB", names: { en: "United Kingdom" } },
      subdivisions: [
        { geoname_id: 2, iso_code: "ENG", names: { en: "England" } },
        { geoname_id: 3, iso_code: "HAM", names: { en: "Hampshire" } },
      ],
    } as unknown as CityResponse;

    expect(mapCityResponse(record, SOURCE)?.region_code).toBe("ENG");
  });

  it("treats a record with nothing locational as a miss, not an empty hit", () => {
    // Claiming a hit here would say the database answered when all it
    // knows is that the network exists.
    const record = {
      traits: { is_anonymous_proxy: true },
      location: { accuracy_radius: 1000, latitude: 0, longitude: 0 },
    } as unknown as CityResponse;

    expect(mapCityResponse(record, SOURCE)).toBeNull();
  });

  it("carries the source through untouched", () => {
    const record = {
      country: { geoname_id: 1, iso_code: "BR", names: { en: "Brazil" } },
    } as unknown as CityResponse;

    expect(mapCityResponse(record, "maxmind:GeoIP2-City:2027-01-15")?.source).toBe(
      "maxmind:GeoIP2-City:2027-01-15",
    );
  });
});

describe("opening a database", () => {
  it("reports an absent file rather than throwing", () => {
    // A not-yet-provisioned mount must not stop the stage from booting.
    const outcome = openMaxmindLookup(join(tmpdir(), "polaris-no-such-db.mmdb"));
    expect(outcome.kind).toBe("absent");
    expect(outcome.kind === "absent" && outcome.reason.length).toBeGreaterThan(0);
  });

  it("reports a file that is not a database rather than throwing", () => {
    // The shape of a truncated download or an error page saved under
    // the .mmdb name.
    const dir = mkdtempSync(join(tmpdir(), "polaris-geoip-"));
    const path = join(dir, "not-really.mmdb");
    writeFileSync(path, "<html><body>403 Forbidden</body></html>");

    const outcome = openMaxmindLookup(path);
    expect(outcome.kind).toBe("absent");
    expect(outcome.kind === "absent" && outcome.reason).toContain("not a readable mmdb database");
  });
});
