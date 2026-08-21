/**
 * One participation: a profile part-way through one version of one graph.
 *
 * The machine says what a graph does. This says what happens to the row
 * that records a person walking it — whether they may enter again, where
 * they resume when a wait elapses, and what the store must be told
 * afterwards. All of it decided from values; the store itself is the
 * orchestrator's.
 *
 * ## Why the sweep's decision is here and not in the sweep
 *
 * `sweep` in the shell claims due rows, reads a profile, and writes what
 * comes back. Between those it made three judgements — a definition that
 * vanished exits the participant, a wait with no `next` completes it, and
 * anything else resumes at the wait's target — and each is a rule about
 * participation rather than about scheduling. They were reachable only by
 * standing up a repository double and a claim loop; here they are three
 * arguments and a return value.
 *
 * What stays in the shell is genuinely the shell's: which rows are due,
 * the SKIP LOCKED claim that stops two sweeps taking the same one, and
 * publishing.
 */

import type { JourneyDefinition } from "@polaris/journey-catalog";

import { advance, type JourneyEffect, type ProfileSnapshot } from "./machine.js";

/** A participant as the orchestrator reads it. */
export interface ParticipantRow {
  readonly id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly journey: string;
  readonly journey_version: number;
  readonly profile_id: string;
  readonly step_id: string;
  readonly wait_until: Date | null;
}

/**
 * What the store must be told after a participant moved.
 *
 * Exactly three, because a participant is in exactly three states: gone,
 * parked with a due time, or resting on a step with none. A fourth would
 * be a row the sweep can neither claim nor finish.
 */
export type ParticipantAction =
  | { readonly kind: "exit"; readonly reason: string }
  | { readonly kind: "park"; readonly step_id: string; readonly wait_until: Date }
  | { readonly kind: "move"; readonly step_id: string };

/** Whether a swept row moved through its graph or fell off it. */
export type ParticipantOutcome = "advanced" | "orphaned";

export interface ParticipantStep {
  /** What to persist, or null when the walk decided nothing to record. */
  readonly action: ParticipantAction | null;
  readonly effects: readonly JourneyEffect[];
  readonly outcome: ParticipantOutcome;
}

/**
 * Whether a completed participant may enter again.
 *
 * `lastExitedAt` is null when they have never been through. The default is
 * `once` in the catalog, and this is the reading that makes it safe.
 */
export function mayReenter(input: {
  readonly definition: JourneyDefinition;
  readonly lastExitedAt: Date | null;
  readonly now: Date;
}): boolean {
  if (input.lastExitedAt === null) return true;
  const policy = input.definition.reentry;
  if (policy === "once") return false;
  if (policy === "always") return true;
  const elapsedDays = (input.now.getTime() - input.lastExitedAt.getTime()) / 86_400_000;
  return elapsedDays >= policy.after_days;
}

/**
 * Where a claimed participant resumes.
 *
 * The wait it was parked on has elapsed, so the walk continues from the
 * step the wait POINTS AT rather than from the wait itself — otherwise a
 * participant would park again forever on the step it just served.
 *
 * `undefined` means the wait ends the participation, which the catalog
 * allows and reads as "hold them, then finish".
 *
 * Private: `advanceParticipant` is the only caller and the only way a
 * resume decision should be reached, because resuming without walking
 * leaves a claimed row with its `wait_until` already cleared.
 */
function resumeStepFor(definition: JourneyDefinition, stepId: string): string | undefined {
  const step = definition.steps.find((candidate) => candidate.id === stepId);
  return step?.type === "wait" ? step.next : stepId;
}

/**
 * What the store owes after the machine walked one participant.
 *
 * Exit wins over park, which wins over the resting step: an `advance` that
 * ended in an exit may have parked earlier in the same walk, and recording
 * the park would leave a due row for a participation that is over.
 */
export function repositoryActionFor(input: {
  readonly effects: readonly JourneyEffect[];
  readonly restingStepId: string | null;
}): ParticipantAction | null {
  const exited = input.effects.find((effect) => effect.kind === "exit");
  if (exited !== undefined) return { kind: "exit", reason: exited.reason };

  const park = input.effects.find((effect) => effect.kind === "park");
  if (park !== undefined) {
    return { kind: "park", step_id: park.step_id, wait_until: park.wait_until };
  }

  if (input.restingStepId !== null) return { kind: "move", step_id: input.restingStepId };
  return null;
}

/**
 * Advance one claimed participant, definition and all.
 *
 * `definition` is looked up by the version the participant ENTERED on, so
 * `undefined` here means that graph is gone entirely — deleted rather than
 * superseded. Exiting is the honest outcome: there is no path left to
 * walk, and leaving the row claimed-but-unparked would strand it.
 */
export function advanceParticipant(input: {
  readonly definition: JourneyDefinition | undefined;
  readonly participant: ParticipantRow;
  readonly profile: ProfileSnapshot;
  readonly now: Date;
}): ParticipantStep {
  const at = input.participant.step_id;

  if (input.definition === undefined) {
    return {
      action: { kind: "exit", reason: "definition_retired" },
      effects: [
        { kind: "emit", event: "journey.exited", step_id: at, reason: "definition_retired" },
      ],
      outcome: "orphaned",
    };
  }

  const resumeAt = resumeStepFor(input.definition, at);
  if (resumeAt === undefined) {
    return {
      action: { kind: "exit", reason: "completed" },
      effects: [{ kind: "emit", event: "journey.exited", step_id: at, reason: "completed" }],
      outcome: "advanced",
    };
  }

  const result = advance({
    definition: input.definition,
    participation: {
      journey: input.participant.journey,
      journey_version: input.participant.journey_version,
      profile_id: input.participant.profile_id,
      step_id: resumeAt,
    },
    profile: input.profile,
    now: input.now,
  });

  return {
    // `restingStepId` is null only when the walk ended, and it ends with an
    // exit effect — so the fallback is unreachable through `advance` and
    // exists so a `move` action always names a step.
    action: repositoryActionFor({
      effects: result.effects,
      restingStepId: result.restingStepId ?? resumeAt,
    }),
    effects: result.effects,
    outcome: "advanced",
  };
}
