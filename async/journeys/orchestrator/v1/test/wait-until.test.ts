/**
 * A wait can name a moment, not just a duration.
 *
 * `minutes` answers "a day after this profile got here", which is
 * per-participant. It cannot express "when the sale opens", which is the
 * same instant for everyone and unknowable as a duration by an author who
 * does not know when each participant will arrive — the plan specified
 * both forms and only the relative one shipped.
 *
 * The two are mutually exclusive by schema rather than by convention.
 * Neither leaves a participant parked with no due time (the sweep claims
 * on `wait_until <= now`, so a null one is never claimed and the
 * participant is stranded); both would make the resting point mean two
 * things at once.
 */

import {
  type JourneyDefinition,
  journeyDefinitionSchema,
  journeyStepSchema,
} from "@polaris/journey-catalog";
import { describe, expect, it } from "vitest";

import { advance } from "../src/index.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

/** A two-step journey whose only wait is the one under test. */
function journeyWaiting(wait: Record<string, unknown>): JourneyDefinition {
  return journeyDefinitionSchema.parse({
    key: "sale_opening",
    version: 1,
    description: "Holds a profile until the sale opens, then thanks them.",
    trigger: { type: "event", event: "signup.completed" },
    reentry: "once",
    start: "hold",
    steps: [
      { id: "hold", type: "wait", next: "announce", ...wait },
      {
        id: "announce",
        type: "action",
        emit: "journey.step_advanced",
        properties: { message: "sale_open" },
        next: "done",
      },
      { id: "done", type: "exit" },
    ],
  });
}

function parkedAt(definition: JourneyDefinition, now: Date) {
  const result = advance({
    definition,
    participation: {
      journey: definition.key,
      journey_version: definition.version,
      profile_id: "019ffe00-0000-7000-8000-00000000f001",
      step_id: "hold",
    },
    profile: { profile_id: "p", traits: {} },
    now,
    justEntered: true,
  });
  const park = result.effects.find((effect) => effect.kind === "park");
  return { result, park };
}

describe("the wait step's schema", () => {
  it("accepts a relative wait", () => {
    expect(
      journeyStepSchema.safeParse({ id: "hold", type: "wait", minutes: 60 }).success,
    ).toBe(true);
  });

  it("accepts an absolute wait", () => {
    expect(
      journeyStepSchema.safeParse({ id: "hold", type: "wait", until: "2026-11-27T00:00:00Z" })
        .success,
    ).toBe(true);
  });

  it("refuses a wait with neither — the participant would never be claimed", () => {
    // The sweep claims on `wait_until <= now`. A park with no due time is
    // not "waiting forever", it is a row nothing ever looks at again.
    expect(journeyStepSchema.safeParse({ id: "hold", type: "wait" }).success).toBe(false);
  });

  it("refuses a wait with both", () => {
    expect(
      journeyStepSchema.safeParse({
        id: "hold",
        type: "wait",
        minutes: 60,
        until: "2026-11-27T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("refuses a local-time instant, which is the one that fires at the wrong hour", () => {
    for (const until of [
      "2026-11-27T00:00:00", // no zone at all
      "2026-11-27T00:00:00+01:00", // an offset — meaning depends on where it was written
      "2026-11-27", // a date, which is a day, not an instant
      "next friday",
    ]) {
      expect(
        journeyStepSchema.safeParse({ id: "hold", type: "wait", until }).success,
        `${until} should be refused`,
      ).toBe(false);
    }
  });

  it("refuses a well-shaped string that is not a real date", () => {
    expect(
      journeyStepSchema.safeParse({ id: "hold", type: "wait", until: "2026-02-31T00:00:00Z" })
        .success,
    ).toBe(false);
  });
});

describe("the engine's due time", () => {
  it("computes a relative wait from the moment the participant arrives", () => {
    const { park } = parkedAt(journeyWaiting({ minutes: 90 }), NOW);
    expect(park?.wait_until.toISOString()).toBe("2026-08-19T13:30:00.000Z");
  });

  it("uses the named instant for an absolute wait, whoever arrives when", () => {
    const definition = journeyWaiting({ until: "2026-11-27T00:00:00Z" });
    // The property that distinguishes the two forms: two participants
    // reaching the step a month apart come due together.
    const early = parkedAt(definition, new Date("2026-09-01T00:00:00.000Z"));
    const late = parkedAt(definition, new Date("2026-10-01T00:00:00.000Z"));
    expect(early.park?.wait_until.toISOString()).toBe("2026-11-27T00:00:00.000Z");
    expect(late.park?.wait_until.toISOString()).toBe("2026-11-27T00:00:00.000Z");
  });

  it("still parks when the named instant has already passed", () => {
    // Not advanced through. A wait that resolved inline would be the only
    // step able to continue the walk without a resting point, and the
    // walk terminates because every wait stops it. The participant comes
    // due on the sweep's next pass instead — one tick, not never.
    const { result, park } = parkedAt(journeyWaiting({ until: "2020-01-01T00:00:00Z" }), NOW);
    expect(result.restingStepId).toBe("hold");
    expect(park?.wait_until.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(park?.wait_until.getTime()).toBeLessThan(NOW.getTime());
  });
});
