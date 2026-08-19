/**
 * Journey orchestrator v1.
 *
 * Consumes `resolved.events` and `profile.events`, walks participants
 * through the graphs in `catalog/journeys/`, and emits `journey.*` onto the
 * profile plane. It makes no vendor calls: an action's event travels the
 * ordinary destination path like any other.
 */

export {
  type AdvanceResult,
  advance,
  edgesOf,
  evaluatePredicate,
  isForbiddenTrigger,
  type JourneyEffect,
  mayReenter,
  type Participation,
  type ProfileSnapshot,
  stepIds,
} from "./engine.js";
export {
  createKyselyJourneyRepository,
  type EnterInput,
  type JourneyRepository,
  type ParticipantRow,
} from "./repository.js";
export { definitionKey, type SweepInput, type SweepResult, sweep } from "./sweep.js";
