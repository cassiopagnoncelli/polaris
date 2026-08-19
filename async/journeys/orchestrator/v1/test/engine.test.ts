/**
 * Journey semantics, decided in memory.
 *
 * The engine is pure so these rules are testable without a database or a
 * broker — and the rules are the card: the loop guard, finishing on the
 * entry version, branches reading the profile at the moment they are
 * reached rather than at entry, and re-entry policy.
 */
import {
  type JourneyDefinition,
  journeyDefinitionSchema,
  welcomeRecentPurchasers,
} from "@polaris/journey-catalog";
import { describe, expect, it } from "vitest";

import { advance, evaluatePredicate, isForbiddenTrigger, mayReenter } from "../src/index.js";

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
    // source that is not catalog/journeys.
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
          then: "b",
          otherwise: "b",
        },
        {
          id: "b",
          type: "branch" as const,
          when: { trait: "x", op: "exists" as const },
          then: "a",
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
            then: "b",
            otherwise: "b",
          },
          {
            id: "b",
            type: "branch",
            when: { trait: "x", op: "exists" },
            then: "a",
            otherwise: "a",
          },
        ],
      }),
    ).toThrow(/terminates/);
  });
});

describe("re-entry policy", () => {
  const base = welcomeRecentPurchasers;

  it("admits a profile that has never been through", () => {
    expect(mayReenter({ definition: base, lastExitedAt: null, now: NOW })).toBe(true);
  });

  it("refuses a second entry under `once`", () => {
    // The default, and the safe direction: a welcome series that re-fires
    // reaches customers before it reaches a dashboard.
    expect(base.reentry).toBe("once");
    expect(
      mayReenter({ definition: base, lastExitedAt: new Date("2020-01-01T00:00:00Z"), now: NOW }),
    ).toBe(false);
  });

  it("honours `always` and `after_days`", () => {
    const always = { ...base, reentry: "always" as const };
    expect(
      mayReenter({ definition: always, lastExitedAt: new Date("2026-08-18T11:00:00Z"), now: NOW }),
    ).toBe(true);

    const after = { ...base, reentry: { after_days: 30 } };
    expect(
      mayReenter({ definition: after, lastExitedAt: new Date("2026-08-01T12:00:00Z"), now: NOW }),
    ).toBe(false);
    expect(
      mayReenter({ definition: after, lastExitedAt: new Date("2026-07-01T12:00:00Z"), now: NOW }),
    ).toBe(true);
  });
});

describe("predicate evaluation", () => {
  it("treats an absent trait as absent, not as zero", () => {
    // A profile with no `orders_30d` has not ordered zero times; the trait
    // has not been computed for them. `gte: 1` must not match, and
    // `absent` must.
    expect(evaluatePredicate({ trait: "orders_30d", op: "gte", value: 1 }, {})).toBe(false);
    expect(evaluatePredicate({ trait: "orders_30d", op: "absent" }, {})).toBe(true);
    expect(evaluatePredicate({ trait: "orders_30d", op: "exists" }, { orders_30d: 0 })).toBe(true);
  });

  it("refuses an ordered comparison against a non-number", () => {
    // A definition error. Answering `false` is the honest reading — the
    // comparison has no meaning — and the branch takes its otherwise arm.
    expect(evaluatePredicate({ trait: "tier", op: "gte", value: 2 }, { tier: "gold" })).toBe(false);
  });

  it("combines with all / any / not", () => {
    const traits = { orders_30d: 5, tier: "gold" };
    expect(
      evaluatePredicate(
        {
          all: [
            { trait: "orders_30d", op: "gte", value: 2 },
            { not: { trait: "tier", op: "eq", value: "bronze" } },
          ],
        },
        traits,
      ),
    ).toBe(true);
    expect(evaluatePredicate({ any: [{ trait: "tier", op: "eq", value: "silver" }] }, traits)).toBe(
      false,
    );
  });
});
