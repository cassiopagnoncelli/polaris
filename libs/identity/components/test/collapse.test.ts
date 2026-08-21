/**
 * Incremental connected components, with no broker and no database.
 *
 * The one real decision here is that transitive chains collapse at WRITE
 * time. The consumer of this map is a ClickHouse dictionary lookup, and a
 * dictionary cannot iterate: a map storing merges as they were emitted
 * would resolve one hop and stop — silently under-merging, with no error
 * and a number that is merely wrong. These tests are what make that
 * failure impossible to reintroduce quietly.
 */

import { describe, expect, it } from "vitest";

import { collapseComponent, isActionableMerge, type ProfileMerge } from "../src/index.js";

const A = "0193a000-0000-7000-8000-00000000000a";
const B = "0193b000-0000-7000-8000-00000000000b";
const C = "0193c000-0000-7000-8000-00000000000c";

function merge(overrides: Partial<ProfileMerge> = {}): ProfileMerge {
  return {
    winnerProfileId: B,
    loserProfileId: A,
    mergeId: "0193d000-0000-7000-8000-00000000000d",
    reason: "identifiers co-occurred on one event",
    occurredAt: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("collapseComponent", () => {
  it("assigns the loser to the winner", () => {
    const assignments = collapseComponent(merge(), []);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      loserProfileId: A,
      winnerProfileId: B,
      version: Date.parse("2026-08-14T12:00:00.000Z"),
    });
  });

  it("compresses a chain so one lookup lands on the root", () => {
    // A -> B happened on day 1. B -> C arrives now. A reader asking "who
    // is A?" must land on C, and one lookup is all it gets.
    const assignments = collapseComponent(
      merge({ winnerProfileId: C, loserProfileId: B, occurredAt: "2026-08-22T09:00:00.000Z" }),
      [{ loserProfileId: A, mergeId: "merge-a-into-b", reason: "shared email" }],
    );
    const byMember = Object.fromEntries(
      assignments.map((a) => [a.loserProfileId, a.winnerProfileId]),
    );
    expect(byMember[B]).toBe(C);
    expect(byMember[A]).toBe(C);
  });

  it("compresses every member of the component, not only the newest", () => {
    // Three accounts merged over three months still resolve in one hop.
    const assignments = collapseComponent(
      merge({ winnerProfileId: C, loserProfileId: B, occurredAt: "2026-08-22T09:00:00.000Z" }),
      [
        { loserProfileId: A, mergeId: "m-a", reason: "shared email" },
        { loserProfileId: "p-old", mergeId: "m-old", reason: "shared phone" },
      ],
    );
    expect(assignments.map((a) => a.winnerProfileId)).toEqual([C, C, C]);
    expect(assignments.map((a) => a.loserProfileId)).toEqual([B, A, "p-old"]);
  });

  it("stamps every assignment with the TRIGGERING merge's version", () => {
    // The store keeps the highest version per member. A rewrite carrying
    // its own original timestamp would lose to the very row it corrects,
    // and the compression would silently not happen.
    const assignments = collapseComponent(
      merge({ winnerProfileId: C, loserProfileId: B, occurredAt: "2026-08-22T09:00:00.000Z" }),
      [{ loserProfileId: A, mergeId: "merge-a-into-b", reason: "shared email" }],
    );
    const expected = Date.parse("2026-08-22T09:00:00.000Z");
    for (const assignment of assignments) expect(assignment.version).toBe(expected);
  });

  it("keeps each rewritten member's own lineage", () => {
    // This member's reason is still the merge that created it.
    // Overwriting it would claim A and B merged for a cause that only
    // applied to B and C.
    const assignments = collapseComponent(merge({ winnerProfileId: C, loserProfileId: B }), [
      { loserProfileId: A, mergeId: "merge-a-into-b", reason: "shared email" },
    ]);
    const rewritten = assignments.find((a) => a.loserProfileId === A);
    expect(rewritten?.reason).toBe("shared email");
    expect(rewritten?.mergeId).toBe("merge-a-into-b");
  });

  it("does not rewrite a member that already points at the winner", () => {
    // Otherwise every merge in a long chain emits a no-op write for every
    // member already resolved.
    const assignments = collapseComponent(merge({ winnerProfileId: C, loserProfileId: B }), [
      { loserProfileId: C, mergeId: "irrelevant", reason: "x" },
    ]);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.loserProfileId).toBe(B);
  });

  it("is deterministic, so a replay produces identical assignments", () => {
    // The version comes from the MERGE's clock, not the reader's. A
    // redelivery must collapse against the original rather than
    // accumulate beside it.
    const chained = [{ loserProfileId: A, mergeId: "m", reason: "r" }];
    expect(collapseComponent(merge(), chained)).toEqual(collapseComponent(merge(), chained));
  });

  it("refuses a merge whose timestamp cannot be parsed", () => {
    // NaN would stamp a version that loses every collapse race — an
    // assignment written and then silently overwritten by anything at all.
    expect(() => collapseComponent(merge({ occurredAt: "not a date" }), [])).toThrow(RangeError);
  });
});

describe("isActionableMerge", () => {
  it("ignores a self-merge", () => {
    // Harmless to read, but it makes "is this profile merged?" answer yes
    // for a profile that is not.
    expect(isActionableMerge(merge({ winnerProfileId: A, loserProfileId: A }))).toBe(false);
    expect(isActionableMerge(merge())).toBe(true);
  });
});
