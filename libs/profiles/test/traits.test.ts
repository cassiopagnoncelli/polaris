/**
 * The trait model: who may write, and what a write does.
 */

import type { IdentityEnvelope, IdentityPolicy } from "@polaris/identity-rules";
import { describe, expect, it } from "vitest";

import { applyTraitPatch, extractTraits } from "../src/index.js";

const POLICY: IdentityPolicy = {
  denylist: {},
  maxIdentifiersPerKind: 100,
  maxMergesPerWindow: 50,
  mergeWindowSeconds: 3600,
  maxTraitsBytes: 64,
};

function identify(properties: Record<string, unknown>): IdentityEnvelope {
  return { event: "user.identified", properties };
}

describe("extractTraits", () => {
  it("takes traits from an identify-family event", () => {
    expect(extractTraits(identify({ plan: "pro" }), POLICY)).toEqual({
      traits: { plan: "pro" },
      overCap: false,
    });
  });

  it("ignores properties on any other event", () => {
    // Letting any track() push traits reintroduces the write-ordering
    // ambiguity the single-writer rule exists to remove.
    expect(
      extractTraits({ event: "page.viewed", properties: { plan: "pro" } }, POLICY).traits,
    ).toBeNull();
  });

  it("reports an over-cap payload rather than dropping the event", () => {
    // The identifiers still bind — losing an identity link over a
    // payload-size problem would be the worse outcome — and the caller
    // gets the flag it needs to count the skip.
    const huge = identify({ bio: "x".repeat(200) });
    expect(extractTraits(huge, POLICY)).toEqual({ traits: null, overCap: true });
  });

  it("treats an empty properties bag as no traits, not as a patch", () => {
    // An identify() with nothing on it must not bump traits_version and
    // advertise a change that did not happen.
    expect(extractTraits(identify({}), POLICY)).toEqual({ traits: null, overCap: false });
  });

  it("copies rather than aliasing the producer's object", () => {
    const properties = { plan: "pro" };
    const extracted = extractTraits(identify(properties), POLICY).traits;
    properties.plan = "mutated";
    expect(extracted).toEqual({ plan: "pro" });
  });
});

describe("applyTraitPatch", () => {
  it("merges per key and bumps the version", () => {
    expect(applyTraitPatch({ traits: { a: 1, b: 2 }, traitsVersion: 3 }, { b: 9, c: 4 })).toEqual({
      traits: { a: 1, b: 9, c: 4 },
      traitsVersion: 4,
      patched: true,
    });
  });

  it("leaves the version alone when there is nothing to write", () => {
    // Downstream readers order snapshots by this number; bumping it on a
    // no-op would make an unchanged profile look newer than an edited one.
    expect(applyTraitPatch({ traits: { a: 1 }, traitsVersion: 3 }, null)).toEqual({
      traits: { a: 1 },
      traitsVersion: 3,
      patched: false,
    });
  });
});
