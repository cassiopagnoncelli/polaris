/**
 * The traits runner.
 *
 * `diff.test.ts` pins what a change IS. This pins the run: that a profile
 * touched by three traits is written once, that the two emissions have
 * different cardinalities on purpose, and that a run over an unchanged
 * population writes nothing at all.
 */

import { describe, expect, it } from "vitest";

import {
  runTraits,
  type TraitEmitter,
  type TraitProfileStore,
  type TraitQueryRunner,
} from "../src/runner.js";

const A = "profile-a";
const B = "profile-b";

function harness(
  options: {
    results?: Record<string, ReadonlyArray<{ profile_id: string; value: unknown }>>;
    stored?: ReadonlyArray<{ profileId: string; traits: Record<string, unknown> }>;
  } = {},
) {
  const writes: Array<{ profileId: string; set: Record<string, unknown>; remove: string[] }> = [];
  const profileUpdated: Array<{ profileId: string; traitsVersion: number }> = [];
  const traitComputed: Array<{ traitKey: string; changedCount: number; removedCount: number }> = [];
  let version = 0;

  const query: TraitQueryRunner = {
    run: async ({ sql }) => options.results?.[sql] ?? [],
  };
  const store: TraitProfileStore = {
    profilesWithTraits: async () => options.stored ?? [],
    applyTraitChange: async ({ change }) => {
      writes.push({
        profileId: change.profileId,
        set: { ...change.set },
        remove: [...change.remove],
      });
      version += 1;
      return { traitsVersion: version };
    },
  };
  const emitter: TraitEmitter = {
    profileUpdated: async (input) => {
      profileUpdated.push({ profileId: input.profileId, traitsVersion: input.traitsVersion });
    },
    traitComputed: async (input) => {
      traitComputed.push({
        traitKey: input.traitKey,
        changedCount: input.changedCount,
        removedCount: input.removedCount,
      });
    },
  };
  return { query, store, emitter, writes, profileUpdated, traitComputed };
}

const BASE = {
  projectId: "storefront",
  environment: "production",
  runId: "run-1",
  now: () => 1_000,
};

describe("runTraits", () => {
  it("writes one change per profile even when several traits move", async () => {
    // The property `traits_version` depends on. Writing per trait would make
    // the version count computations rather than describe the profile.
    const h = harness({
      results: {
        "sql-orders": [{ profile_id: A, value: 3 }],
        "sql-tier": [{ profile_id: A, value: "gold" }],
      },
    });
    const result = await runTraits({
      ...BASE,
      traits: [
        { key: "orders_30d", sql: "sql-orders" },
        { key: "tier", sql: "sql-tier" },
      ],
      ...h,
    });

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.set).toEqual({ orders_30d: 3, tier: "gold" });
    expect(result.profilesChanged).toBe(1);
  });

  it("emits ONE profile.updated per changed profile and ONE trait.computed per trait", async () => {
    // Different cardinalities on purpose: the per-profile detail has readers,
    // and a per-profile `trait.computed` would put the same information on
    // the spine twice.
    const h = harness({
      results: {
        "sql-orders": [
          { profile_id: A, value: 1 },
          { profile_id: B, value: 2 },
        ],
        "sql-tier": [{ profile_id: A, value: "gold" }],
      },
    });
    await runTraits({
      ...BASE,
      traits: [
        { key: "orders_30d", sql: "sql-orders" },
        { key: "tier", sql: "sql-tier" },
      ],
      ...h,
    });

    expect(h.profileUpdated).toHaveLength(2);
    expect(h.traitComputed).toHaveLength(2);
  });

  it("writes nothing when the population is unchanged", async () => {
    // A nightly run over a quiet project must not bump a single version —
    // `traits_version` is how a destination tells a profile has moved on.
    const h = harness({
      results: { "sql-orders": [{ profile_id: A, value: 3 }] },
      stored: [{ profileId: A, traits: { orders_30d: 3 } }],
    });
    await runTraits({ ...BASE, traits: [{ key: "orders_30d", sql: "sql-orders" }], ...h });

    expect(h.writes).toHaveLength(0);
    expect(h.profileUpdated).toHaveLength(0);
    // The trait still ran, and still says so.
    expect(h.traitComputed).toEqual([{ traitKey: "orders_30d", changedCount: 0, removedCount: 0 }]);
  });

  it("removes a trait the profile dropped out of", async () => {
    const h = harness({
      results: { "sql-orders": [] },
      stored: [{ profileId: A, traits: { orders_30d: 3 } }],
    });
    await runTraits({ ...BASE, traits: [{ key: "orders_30d", sql: "sql-orders" }], ...h });

    expect(h.writes[0]?.remove).toEqual(["orders_30d"]);
    expect(h.traitComputed[0]?.removedCount).toBe(1);
  });

  it("carries the new version onto profile.updated", async () => {
    // A consumer reading the event must be able to compare it against what
    // it already holds without re-reading the profile.
    const h = harness({ results: { "sql-orders": [{ profile_id: A, value: 3 }] } });
    await runTraits({ ...BASE, traits: [{ key: "orders_30d", sql: "sql-orders" }], ...h });
    expect(h.profileUpdated[0]?.traitsVersion).toBe(1);
  });
});
