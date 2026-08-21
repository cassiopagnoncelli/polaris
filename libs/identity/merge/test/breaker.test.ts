/**
 * The merge-rate breaker: the guard against a merge storm the denylist
 * did not see coming.
 */

import { describe, expect, it } from "vitest";

import { evaluateMergeRate, type MergeRateBounds, mergeWindowStart } from "../src/index.js";

const BOUNDS: MergeRateBounds = { maxMergesPerWindow: 50, mergeWindowSeconds: 3600 };

describe("evaluateMergeRate", () => {
  it("allows a merge below the bound", () => {
    expect(
      evaluateMergeRate({ winnerProfileId: "p", recentMerges: 49, bounds: BOUNDS }).allowed,
    ).toBe(true);
  });

  it("refuses AT the bound, because the bound is a maximum", () => {
    // At exactly the limit the next merge is the one too many. An
    // off-by-one here lets the storm through by one merge per window,
    // forever.
    const verdict = evaluateMergeRate({ winnerProfileId: "p", recentMerges: 50, bounds: BOUNDS });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.suspension).toEqual({
      profileId: "p",
      mergeCount: 50,
    });
  });

  it("reports the count that tripped it, for the operator fact", () => {
    // `identity.merge_suspended` carries this number: a profile sitting
    // far past the bound is a different incident from one that just
    // crossed it.
    const verdict = evaluateMergeRate({ winnerProfileId: "p", recentMerges: 900, bounds: BOUNDS });
    expect(verdict.allowed === false && verdict.suspension.mergeCount).toBe(900);
  });

  it("opens the window `mergeWindowSeconds` before now", () => {
    // The breaker decides and the store counts, so both halves have to
    // agree on where the window starts.
    const now = new Date("2026-08-20T12:00:00.000Z");
    expect(mergeWindowStart(now, BOUNDS).toISOString()).toBe("2026-08-20T11:00:00.000Z");
  });
});
