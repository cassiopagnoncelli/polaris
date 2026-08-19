/**
 * Advance participants whose waits have elapsed.
 *
 * The whole scheduler. `polaris journeys sweep` on a crontab claims the
 * due rows, walks each one through the engine, and applies what comes
 * back. No queue, no timer service, no new technology — the card is
 * explicit about that, and a wait is a timestamp in a table because that
 * is the smallest thing that works.
 *
 * The sweep does not publish. It returns the effects, and the caller —
 * which owns a producer — emits them. That keeps this function testable
 * without a broker and keeps the orchestrator's "no vendor calls" rule
 * trivially true of it.
 */

import type { JourneyDefinition } from "@polaris/journey-catalog";

import { advance, type JourneyEffect, type ProfileSnapshot } from "./engine.js";
import type { JourneyRepository, ParticipantRow } from "./repository.js";

export interface SweepEffect {
  readonly participant: ParticipantRow;
  readonly effects: readonly JourneyEffect[];
}

export interface SweepResult {
  readonly claimed: number;
  readonly advanced: number;
  /** Claimed rows whose definition version is no longer in the catalog. */
  readonly orphaned: number;
  readonly emitted: readonly SweepEffect[];
}

export interface SweepInput {
  readonly repository: JourneyRepository;
  /** Graphs by `key@version` — participants finish on the version they entered. */
  readonly definitions: ReadonlyMap<string, JourneyDefinition>;
  /** Reads the traits a branch compares against. */
  readonly readProfile: (input: {
    readonly project_id: string;
    readonly environment: string;
    readonly profile_id: string;
  }) => Promise<ProfileSnapshot>;
  readonly environment: string;
  readonly now: Date;
  /** Rows per sweep. Bounded so one tick cannot run unboundedly long. */
  readonly limit?: number;
}

export function definitionKey(journey: string, version: number): string {
  return `${journey}@${String(version)}`;
}

export async function sweep(input: SweepInput): Promise<SweepResult> {
  const claimed = await input.repository.claimDue({
    environment: input.environment,
    now: input.now,
    limit: input.limit ?? 500,
  });

  const emitted: SweepEffect[] = [];
  let advancedCount = 0;
  let orphaned = 0;

  for (const participant of claimed) {
    // The version it ENTERED on, not the newest. A participant parked in a
    // wait that a later version removed must still finish the graph it
    // started, which is the whole reason the version is on the row.
    const definition = input.definitions.get(
      definitionKey(participant.journey, participant.journey_version),
    );

    if (definition === undefined) {
      // The graph is gone entirely — the definition was deleted rather than
      // superseded. Exiting is the honest outcome: there is no path left to
      // walk, and leaving the row claimed-but-unparked would strand it.
      await input.repository.exit({
        id: participant.id,
        reason: "definition_retired",
        at: input.now,
      });
      emitted.push({
        participant,
        effects: [
          {
            kind: "emit",
            event: "journey.exited",
            step_id: participant.step_id,
            reason: "definition_retired",
          },
        ],
      });
      orphaned += 1;
      continue;
    }

    const profile = await input.readProfile({
      project_id: participant.project_id,
      environment: participant.environment,
      profile_id: participant.profile_id,
    });

    // The wait it was parked on has elapsed, so resume from the step the
    // wait points at rather than re-entering the wait itself — otherwise a
    // participant would park again forever on the step it just served.
    const waitStep = definition.steps.find((step) => step.id === participant.step_id);
    const resumeAt = waitStep?.type === "wait" ? waitStep.next : participant.step_id;

    if (resumeAt === undefined) {
      // A wait with no `next` ends the participation, which the catalog
      // allows and reads as "hold them, then finish".
      await input.repository.exit({ id: participant.id, reason: "completed", at: input.now });
      emitted.push({
        participant,
        effects: [
          {
            kind: "emit",
            event: "journey.exited",
            step_id: participant.step_id,
            reason: "completed",
          },
        ],
      });
      advancedCount += 1;
      continue;
    }

    const result = advance({
      definition,
      participation: {
        journey: participant.journey,
        journey_version: participant.journey_version,
        profile_id: participant.profile_id,
        step_id: resumeAt,
      },
      profile,
      now: input.now,
    });

    const park = result.effects.find((effect) => effect.kind === "park");
    const exited = result.effects.find((effect) => effect.kind === "exit");

    if (exited !== undefined) {
      await input.repository.exit({
        id: participant.id,
        reason: exited.reason,
        at: input.now,
      });
    } else if (park !== undefined) {
      await input.repository.moveTo({
        id: participant.id,
        step_id: park.step_id,
        wait_until: park.wait_until,
      });
    } else {
      await input.repository.moveTo({
        id: participant.id,
        step_id: result.restingStepId ?? resumeAt,
        wait_until: null,
      });
    }

    emitted.push({ participant, effects: result.effects });
    advancedCount += 1;
  }

  return { claimed: claimed.length, advanced: advancedCount, orphaned, emitted };
}
