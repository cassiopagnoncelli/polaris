/**
 * The trait diff.
 *
 * Three decisions carry the weight, and all three are about what a MISSING
 * value means and what counts as a change — the parts that decide whether
 * `traits_version` is a useful signal or noise.
 */

import { describe, expect, it } from "vitest";

import { diffTrait, mergeChanges } from "../src/diff.js";

const A = "profile-a";
const B = "profile-b";

describe("diffTrait", () => {
  it("writes a new value", () => {
    const changes = diffTrait({
      key: "orders_30d",
      computed: [{ profileId: A, value: 3 }],
      stored: [],
    });
    expect(changes).toEqual([{ profileId: A, set: { orders_30d: 3 }, remove: [] }]);
  });

  it("writes nothing when the value is unchanged", () => {
    // `traits_version` is how a destination tells whether a profile it
    // already sent has moved on. Bumping it nightly for every unchanged
    // profile would make that signal useless.
    const changes = diffTrait({
      key: "orders_30d",
      computed: [{ profileId: A, value: 3 }],
      stored: [{ profileId: A, traits: { orders_30d: 3 } }],
    });
    expect(changes).toEqual([]);
  });

  it("REMOVES a trait that computed to nothing, rather than zeroing it", () => {
    // The decision. Defaulting to 0 makes "ordered nothing in 30 days"
    // indistinguishable from "never computed", and an audience built on
    // `orders_30d = 0` would silently include every profile the trait has
    // never seen.
    const changes = diffTrait({
      key: "orders_30d",
      computed: [],
      stored: [{ profileId: A, traits: { orders_30d: 3 } }],
    });
    expect(changes).toEqual([{ profileId: A, set: {}, remove: ["orders_30d"] }]);
  });

  it("does not remove a trait the profile never carried", () => {
    const changes = diffTrait({
      key: "orders_30d",
      computed: [],
      stored: [{ profileId: A, traits: { tier: "gold" } }],
    });
    expect(changes).toEqual([]);
  });

  it("compares objects structurally", () => {
    // Reference equality would report every run as a change.
    const changes = diffTrait({
      key: "favourite",
      computed: [{ profileId: A, value: { sku: "x" } }],
      stored: [{ profileId: A, traits: { favourite: { sku: "x" } } }],
    });
    expect(changes).toEqual([]);
  });

  it("treats a false value as a value, not as absence", () => {
    const changes = diffTrait({
      key: "is_vip",
      computed: [{ profileId: A, value: false }],
      stored: [{ profileId: A, traits: { is_vip: true } }],
    });
    expect(changes).toEqual([{ profileId: A, set: { is_vip: false }, remove: [] }]);
  });
});

describe("mergeChanges", () => {
  it("collapses several traits on one profile into ONE change", () => {
    // Which is what makes `traits_version` bump once per profile per run.
    // Bumping per trait would make it count computations rather than
    // describe the profile.
    const merged = mergeChanges([
      [{ profileId: A, set: { orders_30d: 3 }, remove: [] }],
      [{ profileId: A, set: { tier: "gold" }, remove: [] }],
      [{ profileId: A, set: {}, remove: ["stale"] }],
    ]);
    expect(merged).toEqual([
      { profileId: A, set: { orders_30d: 3, tier: "gold" }, remove: ["stale"] },
    ]);
  });

  it("keeps profiles separate", () => {
    const merged = mergeChanges([
      [{ profileId: A, set: { orders_30d: 1 }, remove: [] }],
      [{ profileId: B, set: { orders_30d: 2 }, remove: [] }],
    ]);
    expect(merged).toHaveLength(2);
  });

  it("returns nothing when no trait changed", () => {
    expect(mergeChanges([[], []])).toEqual([]);
  });
});
