/**
 * Journey orchestrator v1.
 *
 * Consumes `resolved.events` and `profile.events`, walks participants
 * through the graphs in `catalog/journeys/`, and emits `journey.*` onto the
 * profile plane. It makes no vendor calls: an action's event travels the
 * ordinary destination path like any other.
 */

export {
  advance,
  type AdvanceResult,
  edgesOf,
  evaluatePredicate,
  isForbiddenTrigger,
  type JourneyEffect,
  mayReenter,
  type Participation,
  type ProfileSnapshot,
  stepIds,
} from "./engine.js";
