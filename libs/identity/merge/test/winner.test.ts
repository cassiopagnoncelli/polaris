/**
 * Winner selection is a REPLAY property, not a preference.
 *
 * Unmerge is replay-rebuild, so the same events replayed have to pick the
 * same survivor. If they did not, a rebuild meant to repair one bad merge
 * would re-mint every profile id downstream of it and every `profile_id`
 * already stamped into ClickHouse history would stop resolving.
 */

import { describe, expect, it } from "vitest";

import { selectMergeWinner } from "../src/index.js";

function candidate(profileId: string, iso: string): { profileId: string; firstSeenAt: Date } {
  return { profileId, firstSeenAt: new Date(iso) };
}

describe("selectMergeWinner", () => {
  it("keeps the older profile", () => {
    const selection = selectMergeWinner([
      candidate("p-new", "2026-08-20T00:00:00.000Z"),
      candidate("p-old", "2026-01-01T00:00:00.000Z"),
    ]);
    expect(selection?.winner.profileId).toBe("p-old");
    expect(selection?.losers.map((l) => l.profileId)).toEqual(["p-new"]);
  });

  it("breaks a tie on the lower id, as a string", () => {
    // Two profiles created inside the same millisecond compare equal on
    // first_seen_at, and "whichever the store returned first" is not a
    // rule. uuidv7 sorts as a string in creation order, so this stays a
    // meaningful tiebreak rather than an arbitrary one.
    const same = "2026-08-20T00:00:00.000Z";
    const selection = selectMergeWinner([candidate("b", same), candidate("a", same)]);
    expect(selection?.winner.profileId).toBe("a");
  });

  it("returns the same answer whatever order the candidates arrive in", () => {
    const one = candidate("p-1", "2026-02-01T00:00:00.000Z");
    const two = candidate("p-2", "2026-01-01T00:00:00.000Z");
    expect(selectMergeWinner([one, two])?.winner).toEqual(selectMergeWinner([two, one])?.winner);
  });

  it("orders every loser, not just the first", () => {
    // A three-way collapse repoints each loser in turn, and the order it
    // does that in has to be reproducible too.
    const selection = selectMergeWinner([
      candidate("c", "2026-03-01T00:00:00.000Z"),
      candidate("a", "2026-01-01T00:00:00.000Z"),
      candidate("b", "2026-02-01T00:00:00.000Z"),
    ]);
    expect(selection?.winner.profileId).toBe("a");
    expect(selection?.losers.map((l) => l.profileId)).toEqual(["b", "c"]);
  });

  it("refuses to call one profile a merge", () => {
    // Not a merge, and a caller that routed here with one profile has a
    // bug worth surfacing rather than a merge worth performing.
    expect(selectMergeWinner([candidate("solo", "2026-01-01T00:00:00.000Z")])).toBeNull();
    expect(selectMergeWinner([])).toBeNull();
  });
});
