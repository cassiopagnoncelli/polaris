/**
 * Admission: the message loop, from an arriving event to a written row.
 *
 * The loop-guard test here is the important one: this service consumes the
 * plane it publishes to, so its own `journey.*` output arrives back at its
 * own input on every run. Whether an event MATCHES a definition's trigger
 * is `@polaris/engage-journeys`' question and is tested there; this is
 * about what the loop does with the answer.
 */
import { welcomeRecentPurchasers } from "@polaris/journey-catalog";
import { describe, expect, it } from "vitest";

import {
  handleEvent,
  type IncomingEvent,
  type JourneyRepository,
  type ParticipantRow,
} from "../src/index.js";

const PROFILE = "019ffe00-0000-7000-8000-00000000f001";
const NOW = new Date("2026-08-18T12:00:00.000Z");

function event(overrides: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    event_id: "evt-1",
    event: "audience.entered",
    project_id: "storefront",
    environment: "development",
    occurred_at: NOW.toISOString(),
    profile: { profile_id: PROFILE },
    properties: { audience: "recent_purchasers" },
    ...overrides,
  };
}

function fakeRepository(options: { entered?: boolean; lastExitedAt?: Date | null } = {}) {
  const calls = { enters: 0, exits: 0, moves: [] as string[] };
  const repository: JourneyRepository = {
    enterIfAbsent: async (input) => {
      calls.enters += 1;
      if (options.entered === false) return "already_participating";
      return { ...input, wait_until: null } as ParticipantRow;
    },
    lastExitedAt: async () => options.lastExitedAt ?? null,
    claimDue: async () => [],
    moveTo: async ({ step_id }) => {
      calls.moves.push(step_id);
    },
    exit: async () => {
      calls.exits += 1;
    },
    exitAllForProfile: async () => [],
  };
  return { repository, calls };
}

function deps(repository: JourneyRepository, traits: Record<string, unknown> = {}) {
  return {
    definitions: [welcomeRecentPurchasers],
    repository,
    readProfile: async () => ({ profile_id: PROFILE, traits }),
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    now: () => NOW,
    newId: () => "polaris_jp_fixed",
    run_id: "run-1",
  };
}

describe("the loop guard, where it actually bites", () => {
  it("drops every journey.* event before consulting a definition", async () => {
    // This service publishes onto `profile.events` and subscribes to it, so
    // its own output arrives at its own input. Without this check a
    // definition triggering on an event could enter a profile into itself
    // and the pair would run as fast as the spine carries messages.
    const { repository, calls } = fakeRepository();

    for (const name of ["journey.entered", "journey.step_advanced", "journey.exited"]) {
      const result = await handleEvent(event({ event: name }), deps(repository));
      expect(result.skipped).toBe("forbidden_trigger");
      expect(result.published).toEqual([]);
    }
    // Not even a repository read: the guard is before any work.
    expect(calls.enters).toBe(0);
  });
});

describe("admission", () => {
  it("admits a profile and emits entered plus the park", async () => {
    const { repository, calls } = fakeRepository();

    const result = await handleEvent(event(), deps(repository));

    expect(calls.enters).toBe(1);
    // The first step is a wait, so the participant parks and only
    // `journey.entered` goes out.
    expect(result.published.map((p) => p.event)).toEqual(["journey.entered"]);
    expect(result.published[0]).toMatchObject({
      project_id: "storefront",
      environment: "development",
      profile_id: PROFILE,
      properties: {
        journey: "welcome_recent_purchasers",
        journey_version: 1,
        step_id: "settle",
        trigger: "recent_purchasers",
        re_entry: false,
        run_id: "run-1",
      },
    });
    expect(calls.moves).toEqual(["settle"]);
  });

  it("treats a redelivered trigger as already participating, not an error", async () => {
    // Entry is an INSERT against a partial unique index; the constraint
    // refusing is the NORMAL outcome for a redelivery, two partitions
    // carrying one transition, or a replay.
    const { repository } = fakeRepository({ entered: false });

    const result = await handleEvent(event(), deps(repository));

    expect(result.skipped).toBe("already_participating");
    expect(result.published).toEqual([]);
  });

  it("refuses re-entry under `once`", async () => {
    const { repository, calls } = fakeRepository({ lastExitedAt: new Date("2026-01-01") });

    const result = await handleEvent(event(), deps(repository));

    expect(result.skipped).toBe("reentry_refused");
    // Refused BEFORE the insert, so the unique index is not doing this job.
    expect(calls.enters).toBe(0);
  });

  it("drops an event with no resolved profile", async () => {
    // A journey is about a person. An event the identity stage could not
    // resolve has nobody to admit.
    const { repository, calls } = fakeRepository();

    const result = await handleEvent(event({ profile: undefined }), deps(repository));

    expect(result.skipped).toBe("no_profile");
    expect(calls.enters).toBe(0);
  });

  it("ignores an event no journey triggers on", async () => {
    const { repository, calls } = fakeRepository();

    const result = await handleEvent(event({ event: "page.viewed" }), deps(repository));

    expect(result.skipped).toBe("no_matching_journey");
    expect(calls.enters).toBe(0);
  });
});
