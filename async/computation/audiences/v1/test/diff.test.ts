/**
 * Membership diffing (C195TM1C).
 *
 * The load-bearing property is silence: an unchanged population must
 * produce no transitions. Everything downstream — the vendor write per
 * event, the lock-free cron, the claim that this stream carries changes —
 * rests on it.
 */

import { describe, expect, it } from "vitest";

import { diffAudience, type StoredMembership } from "../src/diff.js";

const T0 = new Date("2026-08-01T00:00:00.000Z");
const T1 = new Date("2026-08-10T00:00:00.000Z");

function open(profileId: string, enteredAt = T0): StoredMembership {
  return { profileId, enteredAt, exitedAt: null };
}

function closed(profileId: string, enteredAt = T0, exitedAt = T1): StoredMembership {
  return { profileId, enteredAt, exitedAt };
}

function versions(entries: Record<string, number>): ReadonlyMap<string, number> {
  return new Map(Object.entries(entries));
}

describe("diffAudience — entries", () => {
  it("enters a profile nobody has seen", () => {
    const diff = diffAudience({
      desired: ["p1"],
      stored: [],
      version: 1,
      storedVersions: versions({}),
    });
    expect(diff.transitions).toEqual([{ kind: "entered", profileId: "p1", reEntry: false }]);
  });

  it("marks a returning profile as a re-entry", () => {
    // The exited row survives precisely so this is knowable. A welcome
    // campaign needs the difference and cannot derive it from the stream.
    const diff = diffAudience({
      desired: ["p1"],
      stored: [closed("p1")],
      version: 1,
      storedVersions: versions({ p1: 1 }),
    });
    expect(diff.transitions).toEqual([{ kind: "entered", profileId: "p1", reEntry: true }]);
  });
});

describe("diffAudience — exits", () => {
  it("exits an open member who no longer qualifies", () => {
    const diff = diffAudience({
      desired: [],
      stored: [open("p1")],
      version: 1,
      storedVersions: versions({ p1: 1 }),
    });
    expect(diff.transitions).toEqual([{ kind: "exited", profileId: "p1", enteredAt: T0 }]);
  });

  it("carries the membership start so dwell time is computable", () => {
    const started = new Date("2026-07-04T09:30:00.000Z");
    const diff = diffAudience({
      desired: [],
      stored: [open("p1", started)],
      version: 1,
      storedVersions: versions({ p1: 1 }),
    });
    const [transition] = diff.transitions;
    expect(transition?.kind).toBe("exited");
    expect(transition?.kind === "exited" ? transition.enteredAt : undefined).toEqual(started);
  });

  it("does not re-exit an already-closed membership", () => {
    // Without this the runner would emit an exit every night forever for
    // everyone who ever left.
    const diff = diffAudience({
      desired: [],
      stored: [closed("p1")],
      version: 1,
      storedVersions: versions({ p1: 1 }),
    });
    expect(diff.transitions).toEqual([]);
  });
});

describe("diffAudience — idempotence", () => {
  it("emits nothing for an unchanged population", () => {
    const diff = diffAudience({
      desired: ["p1", "p2"],
      stored: [open("p1"), open("p2")],
      version: 1,
      storedVersions: versions({ p1: 1, p2: 1 }),
    });
    expect(diff.transitions).toEqual([]);
    expect(diff.restamp).toEqual([]);
  });

  it("is stable across repeated runs", () => {
    const stored = [open("p1"), closed("p2")];
    const args = {
      desired: ["p1"],
      stored,
      version: 1,
      storedVersions: versions({ p1: 1, p2: 1 }),
    };
    expect(diffAudience(args).transitions).toEqual([]);
    expect(diffAudience(args).transitions).toEqual([]);
  });

  it("handles simultaneous entries and exits in one pass", () => {
    const diff = diffAudience({
      desired: ["p2"],
      stored: [open("p1")],
      version: 1,
      storedVersions: versions({ p1: 1 }),
    });
    expect(diff.transitions).toHaveLength(2);
    expect(diff.transitions).toContainEqual({ kind: "entered", profileId: "p2", reEntry: false });
    expect(diff.transitions).toContainEqual({ kind: "exited", profileId: "p1", enteredAt: T0 });
  });
});

describe("diffAudience — a version bump is not a re-entry", () => {
  it("restamps a continuing member instead of exiting and re-entering", () => {
    // Scoping membership by version would make every predicate tweak,
    // including a typo fix, churn the entire population — indistinguishable
    // downstream from every customer leaving and rejoining overnight.
    const diff = diffAudience({
      desired: ["p1"],
      stored: [open("p1")],
      version: 2,
      storedVersions: versions({ p1: 1 }),
    });
    expect(diff.transitions).toEqual([]);
    expect(diff.restamp).toEqual(["p1"]);
  });

  it("does not restamp a member already on the current version", () => {
    const diff = diffAudience({
      desired: ["p1"],
      stored: [open("p1")],
      version: 2,
      storedVersions: versions({ p1: 2 }),
    });
    expect(diff.restamp).toEqual([]);
  });

  it("still exits someone the new version excludes", () => {
    const diff = diffAudience({
      desired: [],
      stored: [open("p1")],
      version: 2,
      storedVersions: versions({ p1: 1 }),
    });
    expect(diff.transitions).toEqual([{ kind: "exited", profileId: "p1", enteredAt: T0 }]);
    expect(diff.restamp).toEqual([]);
  });
});
