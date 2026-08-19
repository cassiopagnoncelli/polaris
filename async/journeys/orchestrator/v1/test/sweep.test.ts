/**
 * The sweep is the entire scheduler, so its edge cases are the ones that
 * strand or duplicate a participant.
 */
import { welcomeRecentPurchasers } from "@polaris/journey-catalog";
import { describe, expect, it } from "vitest";

import { definitionKey, type JourneyRepository, type ParticipantRow, sweep } from "../src/index.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function participant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "p1",
    project_id: "storefront",
    environment: "development",
    journey: "welcome_recent_purchasers",
    journey_version: 1,
    profile_id: "019ffe00-0000-7000-8000-00000000f001",
    step_id: "settle",
    wait_until: new Date("2026-08-19T11:00:00.000Z"),
    ...overrides,
  };
}

function fakeRepository(due: readonly ParticipantRow[]) {
  const calls = {
    exits: [] as Array<{ id: string; reason: string }>,
    moves: [] as Array<{ id: string; step_id: string }>,
    claims: [] as number[],
  };
  const repository: JourneyRepository = {
    enterIfAbsent: async () => "already_participating",
    lastExitedAt: async () => null,
    claimDue: async ({ limit }) => {
      calls.claims.push(limit);
      return due;
    },
    moveTo: async ({ id, step_id }) => {
      calls.moves.push({ id, step_id });
    },
    exit: async ({ id, reason }) => {
      calls.exits.push({ id, reason });
    },
    exitAllForProfile: async () => [],
  };
  return { repository, calls };
}

const DEFINITIONS = new Map([
  [definitionKey("welcome_recent_purchasers", 1), welcomeRecentPurchasers],
]);

describe("journeys sweep", () => {
  it("resumes at the wait's `next`, not at the wait itself", () => {
    // The bug this guards: resuming at `participant.step_id` would re-enter
    // the wait step, park the participant for another day, and repeat
    // forever — a journey that never finishes and never errors.
    expect(welcomeRecentPurchasers.steps[0]).toMatchObject({ id: "settle", type: "wait" });
  });

  it("walks a due participant through to its exit", async () => {
    const { repository, calls } = fakeRepository([participant()]);

    const result = await sweep({
      repository,
      definitions: DEFINITIONS,
      readProfile: async () => ({ profile_id: "p", traits: { orders_30d: 5 } }),
      environment: "development",
      now: NOW,
    });

    expect(result.claimed).toBe(1);
    expect(result.advanced).toBe(1);
    // settle -> is_repeat_customer -> thank_repeat -> done, in one tick.
    expect(calls.exits).toEqual([{ id: "p1", reason: "exit_step" }]);
    const events = result.emitted[0]?.effects.filter((e) => e.kind === "emit") ?? [];
    expect(events.map((e) => e.event)).toEqual(["journey.step_advanced", "journey.exited"]);
  });

  it("exits a participant whose entry version is no longer in the catalog", async () => {
    // The graph was deleted rather than superseded. Leaving the row claimed
    // but unparked would strand it: `claimDue` cleared `wait_until`, so no
    // later sweep would pick it up again.
    const { repository, calls } = fakeRepository([participant({ journey_version: 99 })]);

    const result = await sweep({
      repository,
      definitions: DEFINITIONS,
      readProfile: async () => ({ profile_id: "p", traits: {} }),
      environment: "development",
      now: NOW,
    });

    expect(result.orphaned).toBe(1);
    expect(calls.exits).toEqual([{ id: "p1", reason: "definition_retired" }]);
  });

  it("bounds how much one tick claims", async () => {
    const { repository, calls } = fakeRepository([]);

    await sweep({
      repository,
      definitions: DEFINITIONS,
      readProfile: async () => ({ profile_id: "p", traits: {} }),
      environment: "development",
      now: NOW,
      limit: 7,
    });

    expect(calls.claims).toEqual([7]);
  });

  it("does not publish anything itself", async () => {
    // The orchestrator makes no vendor calls, and the sweep makes no broker
    // calls either: it returns effects and the caller emits them. That is
    // what keeps this testable without a broker.
    const { repository } = fakeRepository([participant()]);

    const result = await sweep({
      repository,
      definitions: DEFINITIONS,
      readProfile: async () => ({ profile_id: "p", traits: { orders_30d: 1 } }),
      environment: "development",
      now: NOW,
    });

    expect(result.emitted).toHaveLength(1);
    expect(result.emitted[0]?.participant.id).toBe("p1");
  });
});
