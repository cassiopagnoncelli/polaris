/**
 * The journey machine: what happens to one participant, decided in memory.
 *
 * No database, no broker, no clock of its own. The machine takes a
 * participant's current position, the graph it entered on, and a snapshot
 * of what is true of the profile, and returns the effects to apply. Every
 * rule the card cares about — the loop guard, entry idempotency, wait
 * semantics, finishing on the entry version — is decided here, where it
 * can be tested without infrastructure.
 *
 * `async/journeys/orchestrator/v1` is the shell around it, and does I/O
 * and nothing else.
 *
 * ## Advancing runs to a resting point, not one step
 *
 * A branch is not a place a participant stays. Reaching one means
 * evaluating it and continuing, and the same is true of an action: it
 * emits and moves on. Only a `wait` and an `exit` are resting points.
 *
 * So `advance` loops until it reaches one, collecting the events it
 * emitted on the way. The alternative — one step per call, driven by a
 * sweep — would park a participant on a branch until the next sweep tick,
 * making a graph of three branches take three sweep periods to traverse
 * something that involves no waiting at all.
 *
 * The loop is bounded by the step count, because a definition whose graph
 * cycles without a wait would otherwise spin here. `definitions/journeys`
 * refuses such a definition; this refuses to hang on one that reached it
 * anyway.
 */

import type { AudiencePredicate } from "@polaris/audience-catalog";
import {
  JOURNEY_EVENT_NAMESPACE,
  type JourneyDefinition,
  type JourneyStep,
} from "@polaris/journey-catalog";

/** What is true of a profile, as a branch reads it. */
export interface ProfileSnapshot {
  readonly profile_id: string;
  /** Trait key -> value. Absent keys make `exists` false and `absent` true. */
  readonly traits: Readonly<Record<string, unknown>>;
}

/** Where a participant is. */
export interface Participation {
  readonly journey: string;
  readonly journey_version: number;
  readonly profile_id: string;
  readonly step_id: string;
}

export type JourneyEffect =
  | {
      readonly kind: "emit";
      readonly event: "journey.entered" | "journey.step_advanced" | "journey.exited";
      readonly step_id: string;
      readonly from_step_id?: string;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly reason?: string;
    }
  | { readonly kind: "park"; readonly step_id: string; readonly wait_until: Date }
  | { readonly kind: "exit"; readonly step_id: string; readonly reason: string };

export interface AdvanceResult {
  readonly effects: readonly JourneyEffect[];
  /** Where the participant now rests, or null when the participation ended. */
  readonly restingStepId: string | null;
}

/**
 * A trigger event may never be `journey.*`.
 *
 * The second half of the loop guard. `definitions/journeys/types.ts` refuses
 * such a definition, which protects everything in this repository; this
 * protects against an event reaching the orchestrator by a route the
 * loader never saw — a replay, a hand-published message, a definition
 * source that is not that directory.
 *
 * Both are cheap and neither is redundant: one is a build-time property of
 * the definitions, the other a runtime property of the traffic.
 */
export function isForbiddenTrigger(event: string): boolean {
  return event.startsWith(JOURNEY_EVENT_NAMESPACE);
}

/**
 * Evaluate a branch or trigger predicate against a trait bag.
 *
 * Named for its dialect rather than for its job, because
 * `@polaris/engage-audiences` exports an `evaluatePredicate` over the same
 * `AudiencePredicate` type that answers differently, and this library and
 * that one now sit in one namespace where a reader would reasonably assume
 * they are the same function.
 *
 * They are not, and the difference is `ne` against an ABSENT trait. The
 * audiences evaluator is three-valued, SQL's reading of NULL: every
 * comparison against a trait nobody has computed is false, so `orders_30d
 * ne 5` excludes an unknown profile. This one is two-valued: `actual` is
 * `undefined`, `undefined !== 5` holds, and the branch takes its matched
 * arm. `exists` and `absent` also read `undefined` and `null` alike here,
 * where the audiences evaluator distinguishes a key that is present and
 * null from one that is missing.
 *
 * Q7COB moved both into `libs/engage` and deliberately did NOT merge them:
 * either merge direction silently re-decides which arm a live participant
 * takes at their next branch, which is a semantic change wearing a
 * refactor's clothes. Whether journeys should adopt the audiences reading
 * is a real question and an ADR's, and it is filed rather than answered
 * here.
 */
export function evaluateJourneyPredicate(
  predicate: AudiencePredicate,
  traits: Readonly<Record<string, unknown>>,
): boolean {
  if ("all" in predicate) return predicate.all.every((p) => evaluateJourneyPredicate(p, traits));
  if ("any" in predicate) return predicate.any.some((p) => evaluateJourneyPredicate(p, traits));
  if ("not" in predicate) return !evaluateJourneyPredicate(predicate.not, traits);

  const actual = traits[predicate.trait];
  switch (predicate.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "absent":
      return actual === undefined || actual === null;
    case "in":
      return predicate.values.some((v) => v === actual);
    case "eq":
      return actual === predicate.value;
    case "ne":
      return actual !== predicate.value;
    default:
      break;
  }

  // Ordered comparisons need numbers on both sides. A trait holding a
  // string compared with `gte` is a definition error, and answering
  // `false` would hide it in a branch that quietly always takes the
  // `otherwise` arm.
  if (typeof actual !== "number" || typeof predicate.value !== "number") return false;
  switch (predicate.op) {
    case "gt":
      return actual > predicate.value;
    case "gte":
      return actual >= predicate.value;
    case "lt":
      return actual < predicate.value;
    case "lte":
      return actual <= predicate.value;
    default:
      return false;
  }
}

/**
 * Walk a participant forward until it rests or ends.
 *
 * `now` is injected rather than read: a wait's due time is derived from it,
 * and a sweep replaying a backlog must compute due times from the moment
 * it is processing, not from wall-clock at the moment it happens to run.
 */
export function advance(input: {
  readonly definition: JourneyDefinition;
  readonly participation: Participation;
  readonly profile: ProfileSnapshot;
  readonly now: Date;
  /** Set on the first advance of a new participation. */
  readonly justEntered?: boolean;
}): AdvanceResult {
  const byId = new Map(input.definition.steps.map((step) => [step.id, step]));
  const effects: JourneyEffect[] = [];

  let currentId: string | undefined = input.participation.step_id;
  let previousId: string | undefined;
  let steps = 0;

  if (input.justEntered === true) {
    effects.push({ kind: "emit", event: "journey.entered", step_id: currentId });
  }

  while (currentId !== undefined) {
    // Bounded by the graph size. The catalog refuses a definition whose
    // every path cycles; this refuses to spin on one that arrived anyway.
    steps += 1;
    if (steps > input.definition.steps.length + 1) {
      effects.push({ kind: "exit", step_id: currentId, reason: "definition_retired" });
      effects.push({
        kind: "emit",
        event: "journey.exited",
        step_id: currentId,
        reason: "definition_retired",
      });
      return { effects, restingStepId: null };
    }

    const step: JourneyStep | undefined = byId.get(currentId);
    if (step === undefined) {
      // The step vanished from under the participant. Only reachable when a
      // definition was edited without a version bump, which the catalog
      // forbids; exiting is better than parking them somewhere unreachable.
      effects.push({ kind: "exit", step_id: currentId, reason: "definition_retired" });
      effects.push({
        kind: "emit",
        event: "journey.exited",
        step_id: currentId,
        reason: "definition_retired",
      });
      return { effects, restingStepId: null };
    }

    switch (step.type) {
      case "wait": {
        // A resting point. Two ways to name the due moment, and the schema
        // guarantees exactly one is set:
        //
        //   minutes  relative to THIS participant's arrival here
        //   until    an absolute instant, the same one for everybody
        //
        // An `until` already in the past parks with a due time in the past,
        // which the sweep claims on its next pass — the participant moves
        // one tick later rather than immediately. Advancing straight
        // through instead would make this branch the only step that can
        // continue the walk without a resting point, and the walk's
        // termination argument rests on every wait stopping it.
        const waitUntil =
          step.until !== undefined
            ? new Date(step.until)
            : new Date(input.now.getTime() + (step.minutes ?? 0) * 60_000);
        effects.push({ kind: "park", step_id: step.id, wait_until: waitUntil });
        return { effects, restingStepId: step.id };
      }

      case "branch": {
        // Evaluated NOW, against what is true of the profile at the moment
        // the branch is reached — not at entry. A day may have passed in a
        // wait, and re-reading is the whole reason a branch is a step.
        const taken = evaluateJourneyPredicate(step.when, input.profile.traits)
          ? step.matched
          : step.otherwise;
        previousId = step.id;
        currentId = taken;
        if (currentId === undefined) {
          effects.push({ kind: "exit", step_id: step.id, reason: "completed" });
          effects.push({
            kind: "emit",
            event: "journey.exited",
            step_id: step.id,
            reason: "completed",
          });
          return { effects, restingStepId: null };
        }
        continue;
      }

      case "action": {
        effects.push({
          kind: "emit",
          event: step.emit,
          step_id: step.id,
          ...(previousId !== undefined ? { from_step_id: previousId } : {}),
          ...(step.properties !== undefined ? { properties: step.properties } : {}),
        });
        previousId = step.id;
        currentId = step.next;
        if (currentId === undefined) {
          effects.push({ kind: "exit", step_id: step.id, reason: "completed" });
          effects.push({
            kind: "emit",
            event: "journey.exited",
            step_id: step.id,
            reason: "completed",
          });
          return { effects, restingStepId: null };
        }
        continue;
      }

      case "exit": {
        effects.push({ kind: "exit", step_id: step.id, reason: "exit_step" });
        effects.push({
          kind: "emit",
          event: "journey.exited",
          step_id: step.id,
          reason: "exit_step",
        });
        return { effects, restingStepId: null };
      }

      default: {
        const unreachable: never = step;
        throw new Error(`unknown journey step: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return { effects, restingStepId: null };
}
