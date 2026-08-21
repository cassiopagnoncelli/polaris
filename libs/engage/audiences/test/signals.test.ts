/**
 * The entered/exited signals (C195TM1C).
 *
 * The load-bearing property is silence: an unchanged population must
 * produce no transitions. Everything downstream — the vendor write per
 * event, the lock-free cron, the claim that this stream carries changes —
 * rests on it.
 *
 * Driven through `planAudience`, which is the only way in: the diff itself
 * is private to the evaluator so that a runtime cannot take a second route
 * to the same decision and recount the result.
 */

import { type AudienceDefinition, audienceDefinitionSchema } from "@polaris/audience-catalog";
import { describe, expect, it } from "vitest";

import { planAudience, type StampedMembership } from "../src/index.js";

const T0 = new Date("2026-08-01T00:00:00.000Z");
const T1 = new Date("2026-08-10T00:00:00.000Z");

function definition(version = 1): AudienceDefinition {
  return audienceDefinitionSchema.parse({
    key: "recent_purchasers",
    version,
    description: "test",
    source: "traits",
    predicate: { trait: "orders_30d", op: "gte", value: 1 },
  });
}

function open(profileId: string, enteredAt = T0, audienceVersion = 1): StampedMembership {
  return { profileId, enteredAt, exitedAt: null, audienceVersion };
}

function closed(
  profileId: string,
  enteredAt = T0,
  exitedAt = T1,
  audienceVersion = 1,
): StampedMembership {
  return { profileId, enteredAt, exitedAt, audienceVersion };
}

/** `planAudience`, called the way `diffAudience` used to be. */
function diff(input: {
  desired: readonly string[];
  stored?: readonly StampedMembership[];
  version?: number;
}) {
  return planAudience({
    definition: definition(input.version ?? 1),
    desired: new Set(input.desired),
    stored: input.stored ?? [],
  });
}

describe("audience signals — entries", () => {
  it("enters a profile nobody has seen", () => {
    const plan = diff({
      desired: ["p1"],
      stored: [],
      version: 1,
    });
    expect(plan.transitions).toEqual([{ kind: "entered", profileId: "p1", reEntry: false }]);
  });

  it("marks a returning profile as a re-entry", () => {
    // The exited row survives precisely so this is knowable. A welcome
    // campaign needs the difference and cannot derive it from the stream.
    const plan = diff({
      desired: ["p1"],
      stored: [closed("p1")],
      version: 1,
    });
    expect(plan.transitions).toEqual([{ kind: "entered", profileId: "p1", reEntry: true }]);
  });
});

describe("audience signals — exits", () => {
  it("exits an open member who no longer qualifies", () => {
    const plan = diff({
      desired: [],
      stored: [open("p1")],
      version: 1,
    });
    expect(plan.transitions).toEqual([{ kind: "exited", profileId: "p1", enteredAt: T0 }]);
  });

  it("carries the membership start so dwell time is computable", () => {
    const started = new Date("2026-07-04T09:30:00.000Z");
    const plan = diff({
      desired: [],
      stored: [open("p1", started)],
      version: 1,
    });
    const [transition] = plan.transitions;
    expect(transition?.kind).toBe("exited");
    expect(transition?.kind === "exited" ? transition.enteredAt : undefined).toEqual(started);
  });

  it("does not re-exit an already-closed membership", () => {
    // Without this the runner would emit an exit every night forever for
    // everyone who ever left.
    const plan = diff({
      desired: [],
      stored: [closed("p1")],
      version: 1,
    });
    expect(plan.transitions).toEqual([]);
  });
});

describe("audience signals — idempotence", () => {
  it("emits nothing for an unchanged population", () => {
    const plan = diff({
      desired: ["p1", "p2"],
      stored: [open("p1"), open("p2")],
      version: 1,
    });
    expect(plan.transitions).toEqual([]);
    expect(plan.restamp).toEqual([]);
  });

  it("is stable across repeated runs", () => {
    const stored = [open("p1"), closed("p2")];
    const args = {
      desired: ["p1"],
      stored,
      version: 1,
    };
    expect(diff(args).transitions).toEqual([]);
    expect(diff(args).transitions).toEqual([]);
  });

  it("handles simultaneous entries and exits in one pass", () => {
    const plan = diff({
      desired: ["p2"],
      stored: [open("p1")],
      version: 1,
    });
    expect(plan.transitions).toHaveLength(2);
    expect(plan.transitions).toContainEqual({ kind: "entered", profileId: "p2", reEntry: false });
    expect(plan.transitions).toContainEqual({ kind: "exited", profileId: "p1", enteredAt: T0 });
  });
});

describe("audience signals — a version bump is not a re-entry", () => {
  it("restamps a continuing member instead of exiting and re-entering", () => {
    // Scoping membership by version would make every predicate tweak,
    // including a typo fix, churn the entire population — indistinguishable
    // downstream from every customer leaving and rejoining overnight.
    const plan = diff({
      desired: ["p1"],
      stored: [open("p1")],
      version: 2,
    });
    expect(plan.transitions).toEqual([]);
    expect(plan.restamp).toEqual(["p1"]);
  });

  it("does not restamp a member already on the current version", () => {
    const plan = diff({
      desired: ["p1"],
      stored: [open("p1", T0, 2)],
      version: 2,
    });
    expect(plan.restamp).toEqual([]);
  });

  it("still exits someone the new version excludes", () => {
    const plan = diff({
      desired: [],
      stored: [open("p1")],
      version: 2,
    });
    expect(plan.transitions).toEqual([{ kind: "exited", profileId: "p1", enteredAt: T0 }]);
    expect(plan.restamp).toEqual([]);
  });
});
