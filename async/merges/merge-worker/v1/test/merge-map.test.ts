/**
 * The merge map's one real decision: transitive chains collapse at WRITE
 * time.
 *
 * A ClickHouse dictionary lookup cannot iterate. If the map stored merges as
 * they were emitted, a person-keyed query would resolve one hop and stop —
 * silently under-merging, with no error and a number that is merely wrong.
 * These tests are what make that failure impossible to reintroduce quietly.
 */

import { describe, expect, it } from "vitest";

import { buildMergeRows, isActionableMerge, type MergeEvent } from "../src/merge-map.js";

const A = "0193a000-0000-7000-8000-00000000000a";
const B = "0193b000-0000-7000-8000-00000000000b";
const C = "0193c000-0000-7000-8000-00000000000c";

function merge(overrides: Partial<MergeEvent> = {}): MergeEvent {
  return {
    project_id: "storefront",
    environment: "production",
    winner_profile_id: B,
    loser_profile_id: A,
    merge_id: "0193d000-0000-7000-8000-00000000000d",
    reason: "identifiers co-occurred on one event",
    occurred_at: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildMergeRows", () => {
  it("writes the direct mapping", () => {
    const rows = buildMergeRows(merge(), []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      loser_profile_id: A,
      winner_profile_id: B,
      _version: Date.parse("2026-08-14T12:00:00.000Z"),
    });
  });

  it("collapses a chain so one lookup lands on the survivor", () => {
    // A -> B happened on day 1. B -> C arrives now. A reader asking "who is
    // A?" must land on C, and a dictionary cannot follow two hops.
    const rows = buildMergeRows(
      merge({ winner_profile_id: C, loser_profile_id: B, occurred_at: "2026-08-22T09:00:00.000Z" }),
      [{ loser_profile_id: A, merge_id: "merge-a-into-b", reason: "shared email" }],
    );
    const byLoser = Object.fromEntries(rows.map((r) => [r.loser_profile_id, r.winner_profile_id]));
    expect(byLoser[B]).toBe(C);
    expect(byLoser[A]).toBe(C);
  });

  it("stamps a rewrite with the TRIGGERING merge's version", () => {
    // ReplacingMergeTree keeps the highest `_version`. A rewrite carrying its
    // own original timestamp would lose to the very row it is correcting,
    // and the collapse would silently not happen.
    const rows = buildMergeRows(
      merge({ winner_profile_id: C, loser_profile_id: B, occurred_at: "2026-08-22T09:00:00.000Z" }),
      [{ loser_profile_id: A, merge_id: "merge-a-into-b", reason: "shared email" }],
    );
    const expected = Date.parse("2026-08-22T09:00:00.000Z");
    for (const row of rows) expect(row._version).toBe(expected);
  });

  it("keeps each rewritten row's original reason", () => {
    // The row's lineage is still the merge that created it. Overwriting the
    // reason would make the map claim A and B merged for a cause that only
    // applied to B and C.
    const rows = buildMergeRows(merge({ winner_profile_id: C, loser_profile_id: B }), [
      { loser_profile_id: A, merge_id: "merge-a-into-b", reason: "shared email" },
    ]);
    const rewritten = rows.find((r) => r.loser_profile_id === A);
    expect(rewritten?.reason).toBe("shared email");
    expect(rewritten?.merge_id).toBe("merge-a-into-b");
  });

  it("does not rewrite a row that already points at the winner", () => {
    // Otherwise every merge in a long chain would emit a no-op write for
    // every profile already resolved.
    const rows = buildMergeRows(merge({ winner_profile_id: C, loser_profile_id: B }), [
      { loser_profile_id: C, merge_id: "irrelevant", reason: "x" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.loser_profile_id).toBe(B);
  });

  it("is deterministic, so a replay produces identical rows", () => {
    // The version comes from the EVENT's clock, not the worker's. A redelivery
    // must collapse against the original rather than accumulate beside it.
    const chained = [{ loser_profile_id: A, merge_id: "m", reason: "r" }];
    expect(buildMergeRows(merge(), chained)).toEqual(buildMergeRows(merge(), chained));
  });

  it("refuses a merge whose timestamp cannot be parsed", () => {
    // NaN would stamp a version that loses every collapse race — a row
    // written and then silently overwritten by anything at all.
    expect(() => buildMergeRows(merge({ occurred_at: "not a date" }), [])).toThrow(RangeError);
  });
});

describe("isActionableMerge", () => {
  it("ignores a self-merge", () => {
    // Harmless to read, but it makes "is this profile merged?" answer yes
    // for a profile that is not.
    expect(isActionableMerge(merge({ winner_profile_id: A, loser_profile_id: A }))).toBe(false);
    expect(isActionableMerge(merge())).toBe(true);
  });
});
