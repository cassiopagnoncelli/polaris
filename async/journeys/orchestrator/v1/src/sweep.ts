/**
 * Advance participants whose waits have elapsed.
 *
 * The whole scheduler. `polaris journeys sweep` on a crontab claims the
 * due rows, walks each one through `@polaris/engage-journeys`, and applies
 * what comes back. No queue, no timer service, no new technology — the
 * card is explicit about that, and a wait is a timestamp in a table because
 * that is the smallest thing that works.
 *
 * What is left here after the carve is the scheduling: which rows are due,
 * claiming them so two sweeps take disjoint sets, reading the profile a
 * branch needs, and writing the action back. Every judgement about the
 * participation — a vanished definition, a wait with no `next`, where to
 * resume — is `advanceParticipant`, and testable without any of this.
 *
 * The sweep does not publish. It returns the effects, and the caller —
 * which owns a producer — emits them. That keeps this function testable
 * without a broker and keeps the orchestrator's "no vendor calls" rule
 * trivially true of it.
 */

import {
  advanceParticipant,
  type JourneyEffect,
  type ParticipantRow,
  type ProfileSnapshot,
} from "@polaris/engage-journeys";
import type { JourneyDefinition } from "@polaris/journey-catalog";

import type { JourneyRepository } from "./repository.js";

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

    // A row whose graph is gone needs no profile: it is exiting, and a
    // branch it will never reach is the only thing traits are read for.
    const profile =
      definition === undefined
        ? { profile_id: participant.profile_id, traits: {} }
        : await input.readProfile({
            project_id: participant.project_id,
            environment: participant.environment,
            profile_id: participant.profile_id,
          });

    const step = advanceParticipant({ definition, participant, profile, now: input.now });

    if (step.action?.kind === "exit") {
      await input.repository.exit({
        id: participant.id,
        reason: step.action.reason,
        at: input.now,
      });
    } else if (step.action !== null) {
      await input.repository.moveTo({
        id: participant.id,
        step_id: step.action.step_id,
        wait_until: step.action.kind === "park" ? step.action.wait_until : null,
      });
    }

    emitted.push({ participant, effects: step.effects });
    if (step.outcome === "orphaned") orphaned += 1;
    else advancedCount += 1;
  }

  return { claimed: claimed.length, advanced: advancedCount, orphaned, emitted };
}
