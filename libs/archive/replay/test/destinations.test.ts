/**
 * Destination-reachability tests.
 *
 * This predicate encodes a delivery path that spans three packages, so it is
 * exactly the kind of fact that rots silently when a topology changes — and
 * it did. The previous version of this file pinned the set as a literal,
 * `["analytics.events", "raw.events"]`, with no tie to what destination
 * consumers declare. When 126EPNIQ decommissioned `analytics.events` the
 * predicate went on answering `true` for a dead family and `false` for the
 * spine every vendor reads, and this suite passed the whole way through.
 *
 * "Pinning the set makes an omission loud" is only true if the pin reads
 * something that moves. The last test reads the consumers' own `inputFamily`
 * declarations off disk.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { destinationReachingFamilies, topicFamilyReachesDestinations } from "../src/index.js";

// Four levels: this file sits at `libs/archive/replay/test/`, one deeper than
// the `packages/<name>/test/` it moved from.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("topicFamilyReachesDestinations", () => {
  it("is true for the families that feed the destination consumers", () => {
    // resolved.events: read directly by all five consumers.
    // profile.events: read by braze and webhook-sink, which act on audience
    // membership and journey steps.
    // raw.events: replay's default target — it reaches destinations
    // transitively by re-entering the spine at stage 1.
    expect(topicFamilyReachesDestinations("raw.events")).toBe(true);
    expect(topicFamilyReachesDestinations("resolved.events")).toBe(true);
    expect(topicFamilyReachesDestinations("profile.events")).toBe(true);
  });

  it("is false for the derived families no destination consumer reads", () => {
    for (const family of ["identity.events", "session.events", "attribution.events"]) {
      expect([family, topicFamilyReachesDestinations(family)]).toEqual([family, false]);
    }
  });

  it("is false for the families 126EPNIQ retired", () => {
    // Answering `true` here is what made a replay plan claim vendor reach
    // for a family nothing declares or produces.
    expect(topicFamilyReachesDestinations("analytics.events")).toBe(false);
    expect(topicFamilyReachesDestinations("enriched.events")).toBe(false);
  });

  it("treats a project-isolated topic as its family", () => {
    // Isolation splits a family into `<family>.<project_id>`; the consumers
    // still subscribe, so the traffic still reaches vendors.
    expect(topicFamilyReachesDestinations("resolved.events.storefront")).toBe(true);
    expect(topicFamilyReachesDestinations("raw.events.storefront")).toBe(true);
    expect(topicFamilyReachesDestinations("session.events.storefront")).toBe(false);
  });

  it("is not fooled by a family that merely starts with the same letters", () => {
    expect(topicFamilyReachesDestinations("raw.events-shadow")).toBe(false);
    expect(topicFamilyReachesDestinations("resolved.eventsX")).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(topicFamilyReachesDestinations("  raw.events  ")).toBe(true);
  });

  it("covers every family the destination consumers actually declare", () => {
    // The load-bearing one, and the test the old literal pretended to be.
    // Reads `inputFamily` out of each consumer's app.ts, so a destination
    // that starts reading a new family fails here until the planner knows a
    // replay through it can reach vendors.
    const declared = new Set<string>();
    const root = join(REPO, "sync", "destinations");
    for (const vendor of readdirSync(root)) {
      let source: string;
      try {
        source = readFileSync(join(root, vendor, "v1", "src", "app.ts"), "utf8");
      } catch {
        continue;
      }
      const block = /inputFamily:\s*(\[[^\]]*\]|[A-Z_]+)/.exec(source)?.[1] ?? "";
      for (const constant of block.match(/STREAM_FAMILY_[A-Z_]+/g) ?? []) {
        declared.add(constant.replace("STREAM_FAMILY_", "").toLowerCase().replace(/_/g, "."));
      }
    }

    // Not vacuous: five consumers, each declaring at least one family.
    expect(declared.size).toBeGreaterThan(0);
    const reaching = new Set(destinationReachingFamilies());
    expect([...declared].filter((family) => !reaching.has(family)).sort()).toEqual([]);
  });
});
