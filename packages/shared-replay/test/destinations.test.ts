/**
 * Destination-reachability tests.
 *
 * This predicate encodes a delivery path that spans three packages —
 * analytics-projector reads `raw.events` and writes `analytics.events`, and
 * every destination consumer subscribes to `analytics.events` — so it is
 * exactly the kind of fact that rots silently when a topology changes.
 * Pinning the set here makes an omission loud.
 */

import { describe, expect, it } from "vitest";

import { destinationReachingFamilies, topicFamilyReachesDestinations } from "../src/index.js";

describe("topicFamilyReachesDestinations", () => {
  it("is true for the two families that feed the destination consumers", () => {
    // analytics.events: read directly by braze, ga4, meta-capi, tiktok,
    // webhook-sink. raw.events: read by analytics-projector, which writes
    // analytics.events.
    expect(topicFamilyReachesDestinations("raw.events")).toBe(true);
    expect(topicFamilyReachesDestinations("analytics.events")).toBe(true);
  });

  it("is false for the derived families no destination consumer reads", () => {
    for (const family of [
      "identity.events",
      "enriched.events",
      "session.events",
      "attribution.events",
    ]) {
      expect([family, topicFamilyReachesDestinations(family)]).toEqual([family, false]);
    }
  });

  it("treats a project-isolated topic as its family", () => {
    // Isolation splits a family into `<family>.<project_id>`; the consumers
    // still subscribe, so the traffic still reaches vendors.
    expect(topicFamilyReachesDestinations("analytics.events.storefront")).toBe(true);
    expect(topicFamilyReachesDestinations("raw.events.storefront")).toBe(true);
    expect(topicFamilyReachesDestinations("session.events.storefront")).toBe(false);
  });

  it("is not fooled by a family that merely starts with the same letters", () => {
    expect(topicFamilyReachesDestinations("raw.events-shadow")).toBe(false);
    expect(topicFamilyReachesDestinations("analytics.eventsX")).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(topicFamilyReachesDestinations("  raw.events  ")).toBe(true);
  });

  it("pins the current set, so adding a destination-feeding family is a conscious edit", () => {
    expect([...destinationReachingFamilies()].sort()).toEqual(["analytics.events", "raw.events"]);
  });
});
