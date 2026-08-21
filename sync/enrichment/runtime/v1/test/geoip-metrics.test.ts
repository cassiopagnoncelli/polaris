/**
 * The boot-time geo backend signal.
 *
 * The failure this covers is the one the per-event outcomes cannot see:
 * a database that loads, answers, and has not been refreshed in months.
 * `geo:hit` counts it as a success on every event, because from the
 * event's side it is one.
 */

import { InMemoryIPLookup, MaxmindIPLookup, NoOpIPLookup } from "@polaris/sync-enrichment-geoip-v1";
import { describe, expect, it } from "vitest";

import {
  describeGeoipBackend,
  type GeoipBackendLabels,
  geoipBackendSamples,
  METRIC_GEOIP_DATABASE_BUILD_TIMESTAMP_SECONDS,
  METRIC_GEOIP_DATABASE_LOADED,
} from "../src/geoip-metrics.js";

const IDENTITY: GeoipBackendLabels = {
  processor_name: "sync-enrichment-runtime",
  processor_version: "v1",
  environment: "production",
};

/**
 * A `MaxmindIPLookup` without a 60 MB license-restricted binary.
 *
 * The class reads `buildEpoch` off `mmdb-lib`'s metadata at construction
 * and holds it; what this file is about is what happens to that value
 * afterwards. Constructing the reader is the geoip package's own test
 * (`test/maxmind.test.ts`), and that package makes the same trade for
 * the same reason.
 */
function loadedAt(day: string): MaxmindIPLookup {
  return Object.create(MaxmindIPLookup.prototype, {
    id: { value: `maxmind:GeoLite2-City:${day}`, enumerable: true },
    buildEpoch: { value: new Date(`${day}T00:00:00Z`), enumerable: true },
  }) as MaxmindIPLookup;
}

describe("describing the geo backend", () => {
  it("reports a loaded database with the snapshot it was built from", () => {
    expect(describeGeoipBackend(loadedAt("2026-08-01"))).toEqual({
      source: "maxmind:GeoLite2-City:2026-08-01",
      loaded: true,
      buildEpoch: new Date("2026-08-01T00:00:00Z"),
    });
  });

  it("reports the fail-open no-op as not loaded", () => {
    expect(describeGeoipBackend(new NoOpIPLookup())).toEqual({
      source: "no_lookup",
      loaded: false,
      buildEpoch: null,
    });
  });

  it("counts a non-MaxMind backend as loaded, with no build date to report", () => {
    // The smoke harness and the golden fixtures inject one of these. A
    // backend IS wired, so `loaded` must not read 0 and page nobody at
    // three in the morning over a test double.
    expect(describeGeoipBackend(new InMemoryIPLookup({}))).toEqual({
      source: "in_memory",
      loaded: true,
      buildEpoch: null,
    });
  });
});

describe("the samples the stage publishes", () => {
  it("carries the build epoch in Unix seconds, labelled by source", () => {
    expect(geoipBackendSamples(describeGeoipBackend(loadedAt("2026-08-01")), IDENTITY)).toEqual([
      {
        name: METRIC_GEOIP_DATABASE_LOADED,
        labels: { ...IDENTITY, source: "maxmind:GeoLite2-City:2026-08-01" },
        value: 1,
      },
      {
        name: METRIC_GEOIP_DATABASE_BUILD_TIMESTAMP_SECONDS,
        labels: { ...IDENTITY, source: "maxmind:GeoLite2-City:2026-08-01" },
        value: Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000),
      },
    ]);
  });

  it("omits the build epoch rather than reporting zero when nothing is loaded", () => {
    // A zero would deserialise as 1970 and make `time() - build_timestamp`
    // fire on every stage that has no database at all — a condition the
    // `_loaded` gauge already reports exactly, and whose remedy is
    // different.
    const samples = geoipBackendSamples(describeGeoipBackend(new NoOpIPLookup()), IDENTITY);
    expect(samples).toEqual([
      {
        name: METRIC_GEOIP_DATABASE_LOADED,
        labels: { ...IDENTITY, source: "no_lookup" },
        value: 0,
      },
    ]);
  });

  it("publishes a series whether or not any event has been handled", () => {
    // The per-event `geo:no_backend` outcome needs traffic to exist. An
    // idle stage with no database and an idle stage with one look
    // identical in it; these do not.
    expect(geoipBackendSamples(describeGeoipBackend(new NoOpIPLookup()), IDENTITY)).toHaveLength(1);
  });

  it("carries the environment, so an alert can say which one lost its database", () => {
    // Every annotation on these alerts opens with {{ $labels.environment }}.
    // An unlabelled series renders that as nothing at all, and a warn that
    // cannot name the environment is a warn nobody can act on.
    for (const sample of geoipBackendSamples(describeGeoipBackend(new NoOpIPLookup()), IDENTITY)) {
      expect(sample.labels["environment"]).toBe("production");
      expect(sample.labels["processor_name"]).toBe("sync-enrichment-runtime");
    }
  });
});
