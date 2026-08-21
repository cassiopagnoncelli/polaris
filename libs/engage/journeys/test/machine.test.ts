/**
 * Journey semantics, decided in memory.
 *
 * The engine is pure so these rules are testable without a database or a
 * broker — and the rules are the card: the loop guard, finishing on the
 * entry version, branches reading the profile at the moment they are
 * reached rather than at entry, and re-entry policy.
 */
import {
  AUDIENCE_OPERATORS,
  type AudienceOperator,
  type AudiencePredicate,
} from "@polaris/audience-catalog";
import { evaluatePredicate } from "@polaris/engage-audiences";
import {
  type JourneyDefinition,
  journeyDefinitionSchema,
  welcomeRecentPurchasers,
} from "@polaris/journey-catalog";
import { describe, expect, it } from "vitest";

import { advance, evaluateJourneyPredicate, isForbiddenTrigger } from "../src/index.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function participationAt(step: string, definition: JourneyDefinition) {
  return {
    journey: definition.key,
    journey_version: definition.version,
    profile_id: "019ffe00-0000-7000-8000-00000000f001",
    step_id: step,
  };
}

describe("the loop guard, at runtime", () => {
  it("refuses every journey.* event as a trigger", () => {
    // The catalog refuses such a DEFINITION, which protects this
    // repository. This protects against an event arriving by a route the
    // loader never saw: a replay, a hand-published message, a definition
    // source that is not definitions/journeys.
    expect(isForbiddenTrigger("journey.entered")).toBe(true);
    expect(isForbiddenTrigger("journey.step_advanced")).toBe(true);
    expect(isForbiddenTrigger("journey.exited")).toBe(true);
    // Including one that does not exist yet — the rule is the namespace,
    // not a list that a future event could be added outside of.
    expect(isForbiddenTrigger("journey.something_new")).toBe(true);
  });

  it("allows ordinary events", () => {
    expect(isForbiddenTrigger("payment.approved")).toBe(false);
    expect(isForbiddenTrigger("audience.entered")).toBe(false);
    // Not a prefix match on the bare word: a `journeys.*` domain would be
    // a different namespace and is not what the rule covers.
    expect(isForbiddenTrigger("journeys_other.thing")).toBe(false);
  });
});

describe("advancing a participant", () => {
  it("runs to a resting point rather than one step at a time", () => {
    // A branch is not somewhere a participant stays. Stopping at one would
    // make a graph of three branches take three sweep periods to traverse
    // something involving no waiting at all.
    const result = advance({
      definition: welcomeRecentPurchasers,
      participation: participationAt("is_repeat_customer", welcomeRecentPurchasers),
      profile: { profile_id: "p", traits: { orders_30d: 5 } },
      now: NOW,
    });

    // branch -> action -> exit, in one call.
    expect(result.restingStepId).toBeNull();
    expect(result.effects.map((e) => e.kind)).toEqual(["emit", "exit", "emit"]);
    const emitted = result.effects.filter((e) => e.kind === "emit");
    expect(emitted[0]).toMatchObject({
      event: "journey.step_advanced",
      step_id: "thank_repeat",
      from_step_id: "is_repeat_customer",
      properties: { message: "thank_you_repeat" },
    });
    expect(emitted[1]).toMatchObject({ event: "journey.exited", reason: "exit_step" });
  });

  it("takes the otherwise arm and reads traits at the branch, not at entry", () => {
    const result = advance({
      definition: welcomeRecentPurchasers,
      participation: participationAt("is_repeat_customer", welcomeRecentPurchasers),
      profile: { profile_id: "p", traits: { orders_30d: 1 } },
      now: NOW,
    });

    expect(
      result.effects.find((e) => e.kind === "emit" && e.event === "journey.step_advanced"),
    ).toMatchObject({ properties: { message: "thank_you_first" } });
  });

  it("parks on a wait and computes the due time from the injected clock", () => {
    // Injected rather than read, so a sweep replaying a backlog computes
    // due times from the moment it is processing.
    const result = advance({
      definition: welcomeRecentPurchasers,
      participation: participationAt("settle", welcomeRecentPurchasers),
      profile: { profile_id: "p", traits: {} },
      now: NOW,
      justEntered: true,
    });

    expect(result.restingStepId).toBe("settle");
    const park = result.effects.find((e) => e.kind === "park");
    expect(park).toMatchObject({
      step_id: "settle",
      wait_until: new Date("2026-08-19T12:00:00.000Z"),
    });
    // Entry is announced once, on the first advance.
    expect(result.effects[0]).toMatchObject({ kind: "emit", event: "journey.entered" });
  });

  it("exits rather than parking when a step vanished from under it", () => {
    // Only reachable if a definition was edited without a version bump,
    // which the catalog forbids. Parking a participant on an unreachable
    // step would hold the row forever.
    const result = advance({
      definition: welcomeRecentPurchasers,
      participation: participationAt("no_such_step", welcomeRecentPurchasers),
      profile: { profile_id: "p", traits: {} },
      now: NOW,
    });

    expect(result.restingStepId).toBeNull();
    expect(result.effects.at(-1)).toMatchObject({
      event: "journey.exited",
      reason: "definition_retired",
    });
  });

  it("refuses to spin on a graph that cycles without a wait", () => {
    // The catalog rejects a definition with no terminating path, so this
    // is the second line: a graph reaching the engine by another route
    // must not hang it.
    const cyclic = {
      key: "cyclic",
      version: 1,
      description: "branch that loops to itself",
      trigger: { type: "audience_entered" as const, audience: "recent_purchasers" },
      reentry: "once" as const,
      start: "a",
      steps: [
        {
          id: "a",
          type: "branch" as const,
          when: { trait: "x", op: "exists" as const },
          matched: "b",
          otherwise: "b",
        },
        {
          id: "b",
          type: "branch" as const,
          when: { trait: "x", op: "exists" as const },
          matched: "a",
          otherwise: "a",
        },
      ],
    } as unknown as JourneyDefinition;

    const result = advance({
      definition: cyclic,
      participation: participationAt("a", cyclic),
      profile: { profile_id: "p", traits: { x: 1 } },
      now: NOW,
    });

    expect(result.restingStepId).toBeNull();
    expect(result.effects.at(-1)).toMatchObject({ reason: "definition_retired" });
  });

  it("is the definition the catalog would have refused", () => {
    // Paired with the test above: the engine's guard is a backstop, and the
    // catalog is the actual defence.
    expect(() =>
      journeyDefinitionSchema.parse({
        key: "cyclic",
        version: 1,
        description: "branch that loops to itself",
        trigger: { type: "audience_entered", audience: "recent_purchasers" },
        start: "a",
        steps: [
          {
            id: "a",
            type: "branch",
            when: { trait: "x", op: "exists" },
            matched: "b",
            otherwise: "b",
          },
          {
            id: "b",
            type: "branch",
            when: { trait: "x", op: "exists" },
            matched: "a",
            otherwise: "a",
          },
        ],
      }),
    ).toThrow(/terminates/);
  });
});

/**
 * The whole vocabulary against an absent trait, one case per operator.
 *
 * ADR-0009's table, pinned from the journeys side.
 * `libs/engage/audiences/test/predicate.test.ts` pins the same one from the
 * other, and the duplication is deliberate: `evaluateJourneyPredicate`
 * delegates today, and a suite that only tested the delegation would go
 * green again the moment somebody re-inlined it.
 *
 * `ne` is the row this card exists for. It answered TRUE here until
 * ADR-0009 — `undefined !== 5` — which put a profile out of an audience and
 * down the `matched` arm of a journey on one predicate.
 */
describe("predicate evaluation — every operator against an absent trait", () => {
  const ABSENT_BAGS: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
    ["a missing key", {}],
    ["a null value", { orders_30d: null }],
    ["an undefined value", { orders_30d: undefined }],
  ];

  const ANSWERS: readonly (readonly [AudienceOperator, AudiencePredicate, boolean])[] = [
    ["eq", { trait: "orders_30d", op: "eq", value: 5 }, false],
    ["ne", { trait: "orders_30d", op: "ne", value: 5 }, false],
    ["gt", { trait: "orders_30d", op: "gt", value: 5 }, false],
    ["gte", { trait: "orders_30d", op: "gte", value: 5 }, false],
    ["lt", { trait: "orders_30d", op: "lt", value: 5 }, false],
    ["lte", { trait: "orders_30d", op: "lte", value: 5 }, false],
    ["in", { trait: "orders_30d", op: "in", values: [5] }, false],
    ["exists", { trait: "orders_30d", op: "exists" }, false],
    ["absent", { trait: "orders_30d", op: "absent" }, true],
  ];

  it("covers the operator vocabulary exhaustively", () => {
    expect([...ANSWERS.map(([op]) => op)].sort()).toEqual([...AUDIENCE_OPERATORS].sort());
  });

  for (const [label, bag] of ABSENT_BAGS) {
    for (const [op, predicate, expected] of ANSWERS) {
      it(`${op} is ${String(expected)} against ${label}`, () => {
        expect(evaluateJourneyPredicate(predicate, bag)).toBe(expected);
      });
    }
  }

  it("agrees with the audiences evaluator on every case", () => {
    // The defect this card closed, stated directly: one predicate, one
    // answer, whichever subsystem asks.
    for (const [, bag] of ABSENT_BAGS) {
      for (const [, predicate] of ANSWERS) {
        expect(evaluateJourneyPredicate(predicate, bag)).toBe(evaluatePredicate(predicate, bag));
      }
    }
  });

  it("reads an inherited key as absent", () => {
    // `constructor` passes the trait-key rule, and `{}.constructor` is a
    // function rather than nothing. Reading `traits[key]` instead of
    // `Object.hasOwn` made this trait exist on every profile alive.
    expect(evaluateJourneyPredicate({ trait: "constructor", op: "exists" }, {})).toBe(false);
    expect(evaluateJourneyPredicate({ trait: "constructor", op: "absent" }, {})).toBe(true);
    expect(evaluateJourneyPredicate({ trait: "constructor", op: "ne", value: 5 }, {})).toBe(false);
  });

  it("sends a participant with an absent trait down the otherwise arm of an ne branch", () => {
    // The divergence where it was actually reachable: a branch. Before
    // ADR-0009 this profile took `matched`, and the audience computed from
    // the same predicate excluded them.
    const neBranch = {
      key: "ne_branch",
      version: 1,
      description: "branch on ne against a trait that may be absent",
      trigger: { type: "audience_entered" as const, audience: "recent_purchasers" },
      reentry: "once" as const,
      start: "check",
      steps: [
        {
          id: "check",
          type: "branch" as const,
          when: { trait: "orders_30d", op: "ne" as const, value: 5 },
          matched: "not_five",
          otherwise: "unknown",
        },
        { id: "not_five", type: "exit" as const },
        { id: "unknown", type: "exit" as const },
      ],
    } as unknown as JourneyDefinition;

    const result = advance({
      definition: neBranch,
      participation: participationAt("check", neBranch),
      profile: { profile_id: "p", traits: {} },
      now: NOW,
    });

    expect(result.effects.at(-1)).toMatchObject({ event: "journey.exited", step_id: "unknown" });
  });
});

describe("predicate evaluation", () => {
  it("treats an absent trait as absent, not as zero", () => {
    // A profile with no `orders_30d` has not ordered zero times; the trait
    // has not been computed for them. `gte: 1` must not match, and
    // `absent` must.
    expect(evaluateJourneyPredicate({ trait: "orders_30d", op: "gte", value: 1 }, {})).toBe(false);
    expect(evaluateJourneyPredicate({ trait: "orders_30d", op: "absent" }, {})).toBe(true);
    expect(evaluateJourneyPredicate({ trait: "orders_30d", op: "exists" }, { orders_30d: 0 })).toBe(
      true,
    );
  });

  it("refuses an ordered comparison against a non-number", () => {
    // A definition error. Answering `false` is the honest reading — the
    // comparison has no meaning — and the branch takes its otherwise arm.
    expect(evaluateJourneyPredicate({ trait: "tier", op: "gte", value: 2 }, { tier: "gold" })).toBe(
      false,
    );
  });

  it("combines with all / any / not", () => {
    const traits = { orders_30d: 5, tier: "gold" };
    expect(
      evaluateJourneyPredicate(
        {
          all: [
            { trait: "orders_30d", op: "gte", value: 2 },
            { not: { trait: "tier", op: "eq", value: "bronze" } },
          ],
        },
        traits,
      ),
    ).toBe(true);
    expect(
      evaluateJourneyPredicate({ any: [{ trait: "tier", op: "eq", value: "silver" }] }, traits),
    ).toBe(false);
  });
});
