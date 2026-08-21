/**
 * One participation's rules, with no store under them.
 *
 * These four decisions used to be reachable only through the sweep: to ask
 * what happens to a participant whose definition was deleted you had to
 * stand up a repository double, a claim loop and a profile reader. They are
 * arguments and a return value now, and the sweep's own test is left with
 * the scheduling it actually owns.
 */

import { welcomeRecentPurchasers } from "@polaris/journey-catalog";
import { describe, expect, it } from "vitest";

import {
  advanceParticipant,
  mayReenter,
  type ParticipantRow,
  repositoryActionFor,
} from "../src/index.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const PROFILE = { profile_id: "019ffe00-0000-7000-8000-00000000f001", traits: {} };

function participant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "p1",
    project_id: "storefront",
    environment: "development",
    journey: welcomeRecentPurchasers.key,
    journey_version: welcomeRecentPurchasers.version,
    profile_id: PROFILE.profile_id,
    step_id: "settle",
    wait_until: new Date("2026-08-18T11:00:00.000Z"),
    ...overrides,
  };
}

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

describe("repositoryActionFor", () => {
  it("prefers an exit over a park earlier in the same walk", () => {
    // A walk that parked and then exited must not leave a due row behind:
    // the sweep would claim it and advance a participation that is over.
    const action = repositoryActionFor({
      effects: [
        { kind: "park", step_id: "settle", wait_until: NOW },
        { kind: "exit", step_id: "done", reason: "exit_step" },
      ],
      restingStepId: null,
    });
    expect(action).toEqual({ kind: "exit", reason: "exit_step" });
  });

  it("carries the due time through a park", () => {
    expect(
      repositoryActionFor({
        effects: [{ kind: "park", step_id: "settle", wait_until: NOW }],
        restingStepId: "settle",
      }),
    ).toEqual({ kind: "park", step_id: "settle", wait_until: NOW });
  });

  it("moves to the resting step when the walk neither parked nor exited", () => {
    expect(repositoryActionFor({ effects: [], restingStepId: "thank_first" })).toEqual({
      kind: "move",
      step_id: "thank_first",
    });
  });

  it("records nothing when there is nothing to record", () => {
    expect(repositoryActionFor({ effects: [], restingStepId: null })).toBeNull();
  });
});

describe("advanceParticipant", () => {
  it("exits a participant whose entry version is no longer in the catalog", () => {
    // The graph was deleted rather than superseded. There is no path left
    // to walk, and leaving the row claimed-but-unparked would strand it.
    const step = advanceParticipant({
      definition: undefined,
      participant: participant(),
      profile: PROFILE,
      now: NOW,
    });
    expect(step.outcome).toBe("orphaned");
    expect(step.action).toEqual({ kind: "exit", reason: "definition_retired" });
    expect(step.effects).toEqual([
      { kind: "emit", event: "journey.exited", step_id: "settle", reason: "definition_retired" },
    ]);
  });

  it("resumes at the wait's `next`, never at the wait itself", () => {
    // The bug this guards: resuming at `participant.step_id` would re-enter
    // the wait, park the participant for another day, and repeat forever —
    // a journey that never finishes and never errors.
    const step = advanceParticipant({
      definition: welcomeRecentPurchasers,
      participant: participant(),
      profile: PROFILE,
      now: NOW,
    });
    expect(step.effects.some((effect) => effect.step_id === "settle")).toBe(false);
  });

  it("leaves a participant resting on a step that is not a wait where it is", () => {
    const step = advanceParticipant({
      definition: welcomeRecentPurchasers,
      participant: participant({ step_id: "thank_first" }),
      profile: PROFILE,
      now: NOW,
    });
    expect(step.effects[0]).toMatchObject({
      event: "journey.step_advanced",
      step_id: "thank_first",
    });
  });

  it("completes a participant parked on a wait with no `next`", () => {
    const holdThenFinish = {
      ...welcomeRecentPurchasers,
      steps: [{ id: "settle", type: "wait" as const, minutes: 60 }],
    };
    const step = advanceParticipant({
      definition: holdThenFinish,
      participant: participant(),
      profile: PROFILE,
      now: NOW,
    });
    expect(step.outcome).toBe("advanced");
    expect(step.action).toEqual({ kind: "exit", reason: "completed" });
  });

  it("walks a due participant on from the wait's target, not from the wait", () => {
    // Empty traits, so the branch takes its `otherwise` arm and the walk
    // runs action -> exit without stopping. Nothing rests on a branch.
    const step = advanceParticipant({
      definition: welcomeRecentPurchasers,
      participant: participant(),
      profile: PROFILE,
      now: NOW,
    });
    expect(step.outcome).toBe("advanced");
    expect(step.effects.map((effect) => effect.step_id)).toEqual(["thank_first", "done", "done"]);
    expect(step.action).toEqual({ kind: "exit", reason: "exit_step" });
  });
});
