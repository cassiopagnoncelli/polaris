/**
 * Traits enricher tests.
 *
 * The five outcomes are five different operational facts, and the suite
 * exists mostly to keep them from collapsing into each other: a profile
 * that has no traits yet, one whose row is gone, and one too large to
 * carry all produce `traits: null` on the wire, and an operator needs
 * the metric to tell them apart.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_TRAITS_BYTES, enrichTraits } from "../src/enricher.js";
import type { ProfileReader, ProfileSnapshot } from "../src/reader.js";

const PROFILE_ID = "019ffe00-0000-7000-8000-00000000f001";

function reader(profiles: Record<string, ProfileSnapshot>): ProfileReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readProfile(profileId: string): Promise<ProfileSnapshot | null> {
      reads.push(profileId);
      return profiles[profileId] ?? null;
    },
  };
}

describe("traits enrichment", () => {
  it("returns the committed snapshot and its version", async () => {
    const outcome = await enrichTraits({
      profileId: PROFILE_ID,
      reader: reader({ [PROFILE_ID]: { traits: { tier: "gold" }, traitsVersion: 7 } }),
    });

    expect(outcome.kind).toBe("resolved");
    expect(outcome.traits).toEqual({ tier: "gold" });
    expect(outcome.traitsVersion).toBe(7);
  });

  it("does not read the store for an event with no profile", async () => {
    // A query per unidentifiable event is pure load on the hot path.
    const store = reader({});
    const outcome = await enrichTraits({ profileId: null, reader: store });

    expect(outcome.kind).toBe("unprofiled");
    expect(store.reads).toEqual([]);
  });

  it("separates a profile with no traits from a profile that is not there", async () => {
    // Both carry no traits downstream; only one of them means the spine
    // is naming rows the store does not have.
    const empty = await enrichTraits({
      profileId: PROFILE_ID,
      reader: reader({ [PROFILE_ID]: { traits: {}, traitsVersion: 0 } }),
    });
    expect(empty.kind).toBe("empty");
    expect(empty.traits).toEqual({});

    const missing = await enrichTraits({ profileId: PROFILE_ID, reader: reader({}) });
    expect(missing.kind).toBe("missing");
    expect(missing.traits).toBeNull();
    expect(missing.traitsVersion).toBeNull();
  });

  it("drops an over-size snapshot but still reports which version was too large", async () => {
    const outcome = await enrichTraits(
      {
        profileId: PROFILE_ID,
        reader: reader({
          [PROFILE_ID]: { traits: { blob: "x".repeat(500) }, traitsVersion: 12 },
        }),
      },
      { maxTraitsBytes: 64 },
    );

    expect(outcome.kind).toBe("over_cap");
    expect(outcome.traits).toBeNull();
    // Reported anyway: it costs nothing and makes the offending snapshot
    // identifiable from the emitted event rather than by querying.
    expect(outcome.traitsVersion).toBe(12);
  });

  it("measures the serialised form, which is what the guard protects", async () => {
    // A bag of many small keys costs its JSON size, not its key count.
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i += 1) many[`key_${i}`] = "value";
    const encoded = Buffer.byteLength(JSON.stringify(many), "utf8");

    const under = await enrichTraits(
      {
        profileId: PROFILE_ID,
        reader: reader({ [PROFILE_ID]: { traits: many, traitsVersion: 1 } }),
      },
      { maxTraitsBytes: encoded },
    );
    expect(under.kind).toBe("resolved");

    const over = await enrichTraits(
      {
        profileId: PROFILE_ID,
        reader: reader({ [PROFILE_ID]: { traits: many, traitsVersion: 1 } }),
      },
      { maxTraitsBytes: encoded - 1 },
    );
    expect(over.kind).toBe("over_cap");
  });

  it("applies the manifest default when no guard is supplied", async () => {
    const justUnder = { blob: "x".repeat(DEFAULT_MAX_TRAITS_BYTES - 32) };
    const outcome = await enrichTraits({
      profileId: PROFILE_ID,
      reader: reader({ [PROFILE_ID]: { traits: justUnder, traitsVersion: 1 } }),
    });
    expect(outcome.kind).toBe("resolved");

    const tooBig = { blob: "x".repeat(DEFAULT_MAX_TRAITS_BYTES + 1) };
    const refused = await enrichTraits({
      profileId: PROFILE_ID,
      reader: reader({ [PROFILE_ID]: { traits: tooBig, traitsVersion: 1 } }),
    });
    expect(refused.kind).toBe("over_cap");
  });
});
