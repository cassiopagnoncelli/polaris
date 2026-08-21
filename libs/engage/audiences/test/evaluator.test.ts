/**
 * The evaluator: a definition, some trait rows, and what the run owes.
 *
 * `diff.test.ts` covers the transition rules themselves. What is left here
 * is the seam this card created — that a population is selected from rows
 * the caller supplies, and that the summary a runtime reports is derived
 * from the same three inputs as the transitions rather than recounted.
 */

import { type AudienceDefinition, audienceDefinitionSchema } from "@polaris/audience-catalog";
import { describe, expect, it } from "vitest";

import { membersMatching, planAudience, type StampedMembership } from "../src/index.js";

const RECENT: AudienceDefinition = audienceDefinitionSchema.parse({
  key: "recent_purchasers",
  version: 1,
  description: "test",
  source: "traits",
  predicate: { trait: "orders_30d", op: "gte", value: 1 },
});

const T0 = new Date("2026-08-01T00:00:00.000Z");

function open(profileId: string, audienceVersion = 1): StampedMembership {
  return { profileId, enteredAt: T0, exitedAt: null, audienceVersion };
}

describe("membersMatching", () => {
  it("keeps the profiles the predicate admits and drops the rest", () => {
    const members = membersMatching(RECENT.source === "traits" ? RECENT.predicate : { all: [] }, [
      { profileId: "p1", traits: { orders_30d: 3 } },
      { profileId: "p2", traits: { orders_30d: 0 } },
      { profileId: "p3", traits: {} },
    ]);
    expect([...members]).toEqual(["p1"]);
  });

  it("preserves the caller's order, which the signal stream depends on", () => {
    const predicate = { trait: "orders_30d", op: "gte", value: 1 } as const;
    const rows = [
      { profileId: "p9", traits: { orders_30d: 1 } },
      { profileId: "p2", traits: { orders_30d: 1 } },
      { profileId: "p5", traits: { orders_30d: 1 } },
    ];
    expect([...membersMatching(predicate, rows)]).toEqual(["p9", "p2", "p5"]);
  });

  it("selects nobody from an empty read rather than throwing", () => {
    expect([...membersMatching({ trait: "orders_30d", op: "gte", value: 1 }, [])]).toEqual([]);
  });
});

describe("planAudience", () => {
  it("counts what it decided rather than leaving the caller to recount", () => {
    const plan = planAudience({
      definition: RECENT,
      desired: new Set(["p1", "p2"]),
      stored: [open("p2"), open("p3")],
    });

    expect(plan.transitions).toEqual([
      { kind: "entered", profileId: "p1", reEntry: false },
      { kind: "exited", profileId: "p3", enteredAt: T0 },
    ]);
    expect(plan.summary).toEqual({
      key: "recent_purchasers",
      version: 1,
      members: 2,
      entered: 1,
      exited: 1,
      restamped: 0,
    });
  });

  it("reads the stale stamps off the stored rows, so no caller assembles that map", () => {
    const bumped = audienceDefinitionSchema.parse({
      ...RECENT,
      version: 2,
    }) as AudienceDefinition;

    const plan = planAudience({
      definition: bumped,
      desired: new Set(["p1", "p2"]),
      stored: [open("p1", 1), open("p2", 2)],
    });

    expect(plan.transitions).toEqual([]);
    expect(plan.restamp).toEqual(["p1"]);
    expect(plan.summary.restamped).toBe(1);
    expect(plan.summary.version).toBe(2);
  });

  it("is silent over an unchanged population", () => {
    const plan = planAudience({
      definition: RECENT,
      desired: new Set(["p1"]),
      stored: [open("p1")],
    });
    expect(plan.transitions).toEqual([]);
    expect(plan.restamp).toEqual([]);
    expect(plan.summary).toEqual({
      key: "recent_purchasers",
      version: 1,
      members: 1,
      entered: 0,
      exited: 0,
      restamped: 0,
    });
  });
});
