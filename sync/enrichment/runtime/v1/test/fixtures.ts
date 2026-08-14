/**
 * The world the golden fixtures run against.
 *
 * Held apart from `golden.test.ts` so the generator can import it
 * without importing a suite — and so the recorded outputs and the
 * assertions that check them are demonstrably driven by the same inputs.
 * Every value here is frozen: a fixture whose backing data drifts stops
 * being a regression anchor.
 */

import { InMemoryIPLookup } from "@polaris/sync-enrichment-geoip-v1";

import { InMemoryProfileReader } from "./fakes.js";

/** Profile ids the fixture inputs carry. */
export const FIXTURE_PROFILE_ID = "019ffe00-0000-7000-8000-00000000f001";
export const FIXTURE_BIG_PROFILE_ID = "019ffe00-0000-7000-8000-00000000f002";

/** The fixture geo database — one resolvable address. */
export const FIXTURE_LOOKUP = new InMemoryIPLookup(
  {
    "8.8.8.8": {
      source: "maxmind:GeoLite2-City:2026-08-01",
      country_code: "US",
      region_code: "CA",
      region_name: "California",
      city: "Mountain View",
    },
  },
  { id: "maxmind:GeoLite2-City:2026-08-01" },
);

/** The fixture profile store: one ordinary profile, one over-size one. */
export function fixtureReader(): InMemoryProfileReader {
  const reader = new InMemoryProfileReader();
  reader.set(FIXTURE_PROFILE_ID, {
    traits: { tier: "gold", ltv_band: "high" },
    traitsVersion: 4,
  });
  reader.set(FIXTURE_BIG_PROFILE_ID, {
    traits: { blob: "x".repeat(600) },
    traitsVersion: 11,
  });
  return reader;
}

/**
 * Scenario name → the snapshot guard it runs under.
 *
 * `over-cap-traits-stamps-null` runs narrowed so the fixture profile
 * trips the guard without committing a 32 KiB fixture file.
 */
export const GOLDEN_SCENARIOS: ReadonlyArray<readonly [string, number]> = [
  ["profiled-event-with-traits-and-geo", 32_768],
  ["unprofiled-event-passes-through", 32_768],
  ["over-cap-traits-stamps-null", 256],
  ["no-ip-yields-no-ip-provenance", 32_768],
];
