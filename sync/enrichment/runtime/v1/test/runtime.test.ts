/**
 * Behavioural tests for the enrichment stage.
 *
 * These assert the PROPERTIES the redesign depends on, not the shape of
 * the code: that the spine event survives the hop intact, that both
 * enrichers fail open with honest provenance, that a person keeps one
 * partition, and — the ownership line the two-stage split exists to draw
 * — that this stage cannot write to the profile store.
 */

import { describe, expect, it } from "vitest";

import { InMemoryIPLookup, NoOpIPLookup } from "@polaris/sync-enrichment-geoip-v1";

import { handleEvent } from "../src/runtime.js";
import { InMemoryProfileReader, RecordingProducer, silentLogger } from "./fakes.js";

const RESOLVED = "resolved.events";
const PROFILE_ID = "019ffe00-0000-7000-8000-00000000f001";

const GEO_DB = new InMemoryIPLookup(
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

function makeDeps(options: { maxTraitsBytes?: number; lookup?: NoOpIPLookup } = {}) {
  const reader = new InMemoryProfileReader();
  const producer = new RecordingProducer();
  const now = new Date("2026-08-14T00:00:00.000Z");
  return {
    reader,
    producer,
    deps: {
      reader,
      producer,
      lookup: options.lookup ?? GEO_DB,
      logger: silentLogger,
      policyFor: () => ({ maxTraitsBytes: options.maxTraitsBytes ?? 32_768 }),
      runId: () => "run_1",
      now: () => now,
    },
  };
}

let seq = 0;
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    event_id: `019ffe00-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    event: "page.viewed",
    schema_version: 1,
    project_id: "storefront",
    environment: "development",
    occurred_at: "2026-08-14T00:00:00.000Z",
    ingested_at: "2026-08-14T00:00:01.000Z",
    source: { type: "browser", id: "storefront-web" },
    identity: { anonymous_id: "anon_1", session_id: null, customer_id: null, device_id: null },
    context: { ip: "8.8.8.8", user_agent: null, locale: null, page: null, campaign: null },
    properties: {},
    profile: { profile_id: PROFILE_ID, canonical_customer_id: "cus_1" },
    ...overrides,
  };
}

describe("enrichment stage: traits", () => {
  it("stamps the committed snapshot and its version onto the profile block", async () => {
    const { reader, producer, deps } = makeDeps();
    reader.set(PROFILE_ID, { traits: { tier: "gold" }, traitsVersion: 7 });

    const result = await handleEvent(deps, event());

    expect(result.traitsKind).toBe("resolved");
    const profile = producer.eventsOn(RESOLVED)[0]?.["profile"] as Record<string, unknown>;
    expect(profile["traits"]).toEqual({ tier: "gold" });
    expect(profile["traits_version"]).toBe(7);
    // The identity stage's own fields survive the hop.
    expect(profile["profile_id"]).toBe(PROFILE_ID);
    expect(profile["canonical_customer_id"]).toBe("cus_1");
  });

  it("stamps traits: null when the snapshot exceeds the guard, and still ships", async () => {
    // Truncating would hand destinations a snapshot that looks complete
    // and is not; dropping would lose a real fact over a size problem.
    const { reader, producer, deps } = makeDeps({ maxTraitsBytes: 64 });
    reader.set(PROFILE_ID, { traits: { blob: "x".repeat(500) }, traitsVersion: 9 });

    const result = await handleEvent(deps, event());

    expect(result.traitsKind).toBe("over_cap");
    const profile = producer.eventsOn(RESOLVED)[0]?.["profile"] as Record<string, unknown>;
    expect(profile["traits"]).toBeNull();
    // The version is still reported, so the offending snapshot is
    // identifiable from the event alone.
    expect(profile["traits_version"]).toBe(9);
    expect(producer.eventsOn(RESOLVED)).toHaveLength(1);
  });

  it("ships the event when no profile row bears the stamped id", async () => {
    // Not a race: stage 2 commits before publishing. The row is gone.
    const { producer, deps } = makeDeps();

    const result = await handleEvent(deps, event());

    expect(result.traitsKind).toBe("missing");
    const profile = producer.eventsOn(RESOLVED)[0]?.["profile"] as Record<string, unknown>;
    expect(profile["traits"]).toBeNull();
    expect(producer.eventsOn(RESOLVED)).toHaveLength(1);
  });

  it("does not query the store for an event with no profile", async () => {
    const { reader, producer, deps } = makeDeps();

    const result = await handleEvent(deps, event({ profile: null }));

    expect(result.traitsKind).toBe("unprofiled");
    expect(reader.reads).toEqual([]);
    // A null profile passes through null — no traits slots invented on
    // an event that has no person.
    expect(producer.eventsOn(RESOLVED)[0]?.["profile"]).toBeNull();
  });
});

describe("enrichment stage: geo", () => {
  it("resolves an address and records which database answered", async () => {
    const { producer, deps } = makeDeps();

    const result = await handleEvent(deps, event());

    expect(result.geoKind).toBe("hit");
    const enrichment = producer.eventsOn(RESOLVED)[0]?.["enrichment"] as Record<string, unknown>;
    expect(enrichment["geo"]).toEqual({
      country: "US",
      region: "CA",
      city: "Mountain View",
      source: "maxmind:GeoLite2-City:2026-08-01",
    });
  });

  it("distinguishes 'no address' from 'looked and found nothing'", async () => {
    // Two different facts. A consumer that cannot tell them apart cannot
    // tell a geo outage from a population of server-side events.
    const noIp = makeDeps();
    const withoutAddress = await handleEvent(
      noIp.deps,
      event({ context: { ip: null, user_agent: null, locale: null, page: null, campaign: null } }),
    );
    expect(withoutAddress.geoKind).toBe("no_ip");
    expect(
      (noIp.producer.eventsOn(RESOLVED)[0]?.["enrichment"] as Record<string, unknown>)["geo"],
    ).toEqual({ country: null, region: null, city: null, source: "no_ip" });

    const miss = makeDeps();
    const unknownAddress = await handleEvent(
      miss.deps,
      event({
        context: { ip: "203.0.113.7", user_agent: null, locale: null, page: null, campaign: null },
      }),
    );
    expect(unknownAddress.geoKind).toBe("miss");
    expect(
      (miss.producer.eventsOn(RESOLVED)[0]?.["enrichment"] as Record<string, unknown>)["geo"],
    ).toEqual({
      country: null,
      region: null,
      city: null,
      source: "maxmind:GeoLite2-City:2026-08-01",
    });
  });

  it("runs fail-open with no backend rather than stalling the spine", async () => {
    // Every destination sits behind this stage. A missing geo database
    // must cost geo, not the pipeline.
    const { producer, deps } = makeDeps({ lookup: new NoOpIPLookup() });

    const result = await handleEvent(deps, event());

    // `no_backend`, not `miss`: "geo is down" and "this address is
    // unknown" are different operational facts, and the outcome is what
    // makes the first one countable.
    expect(result.geoKind).toBe("no_backend");
    expect(
      (
        (producer.eventsOn(RESOLVED)[0]?.["enrichment"] as Record<string, unknown>)[
          "geo"
        ] as Record<string, unknown>
      )["source"],
    ).toBe("no_lookup");
    expect(producer.eventsOn(RESOLVED)).toHaveLength(1);
  });

  it("never puts the raw address on the emitted event's enrichment block", async () => {
    const { producer, deps } = makeDeps();
    await handleEvent(deps, event());

    const enrichment = JSON.stringify(producer.eventsOn(RESOLVED)[0]?.["enrichment"]);
    expect(enrichment).not.toContain("8.8.8.8");
    // Defence in depth: no IPv4 octet sequence anywhere in the block.
    expect(enrichment).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u);
  });
});

describe("enrichment stage: the spine event", () => {
  it("preserves event_id and ingested_at, because it is the SAME fact", async () => {
    const { producer, deps } = makeDeps();
    const raw = event();

    await handleEvent(deps, raw);

    const resolved = producer.eventsOn(RESOLVED)[0];
    // A new event_id would make raw / identified / resolved three
    // different events in ClickHouse instead of three sightings of one.
    expect(resolved?.["event_id"]).toBe(raw["event_id"]);
    expect(resolved?.["event"]).toBe(raw["event"]);
    expect(resolved?.["schema_version"]).toBe(raw["schema_version"]);
    expect(resolved?.["occurred_at"]).toBe(raw["occurred_at"]);
    // Restamping ingested_at would zero out every end-to-end lag metric
    // exactly when the pipeline is slowest.
    expect(resolved?.["ingested_at"]).toBe(raw["ingested_at"]);
  });

  it("keys by profile, so a person keeps one partition across both spine hops", async () => {
    const { producer, deps } = makeDeps();
    await handleEvent(deps, event());
    await handleEvent(deps, event({ event: "checkout.started" }));

    const keys = producer.published.map((p) => p.partitionKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain(PROFILE_ID);
  });

  it("emits exactly one event per input, on resolved.events only", async () => {
    // The stage has no derived facts to report: an enrichment is an
    // attribute of the event, not an event about the event.
    const { producer, deps } = makeDeps();
    await handleEvent(deps, event());

    expect(producer.published).toHaveLength(1);
    expect(producer.published[0]?.family).toBe(RESOLVED);
  });
});

describe("enrichment stage: the ownership line", () => {
  it("holds no write path to the profile store", async () => {
    // THE structural invariant of the two-stage split. The reader port
    // is the stage's whole surface onto the profile plane; if a write
    // method ever appears on it, this fails and the reviewer has to
    // justify the change rather than discover it in production.
    const { reader, deps } = makeDeps();
    reader.set(PROFILE_ID, { traits: { tier: "gold" }, traitsVersion: 1 });

    await handleEvent(deps, event());

    const surface = new Set<string>();
    for (const key in deps.reader) surface.add(key);
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(deps.reader))) {
      if (key !== "constructor") surface.add(key);
    }
    const mutators = [...surface].filter((key) =>
      /^(write|insert|update|upsert|delete|patch|save|merge|transaction)/i.test(key),
    );
    expect(mutators).toEqual([]);
  });

  it("leaves the profile untouched across an enrichment", async () => {
    const { reader, deps } = makeDeps();
    const before = { traits: { tier: "gold" }, traitsVersion: 3 };
    reader.set(PROFILE_ID, before);

    await handleEvent(deps, event());

    // Same object, same version: enrichment observed it and moved on.
    await expect(reader.readProfile(PROFILE_ID)).resolves.toEqual(before);
  });
});
