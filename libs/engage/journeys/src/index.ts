/**
 * `@polaris/engage-journeys` public surface.
 *
 * Three modules, and the split is the participant's point of view: the
 * MACHINE is the graph they walk, the INSTANCE is their own row through it,
 * and the TRANSITIONS are the two edges — what admitted them, and what the
 * platform announced about them.
 *
 * None of it holds a connection. `async/journeys/orchestrator/v1` consumes,
 * stores and publishes; everything it decides on the way, it decides here.
 */

export {
  type AdvanceResult,
  advance,
  evaluateJourneyPredicate,
  isForbiddenTrigger,
  type JourneyEffect,
  type Participation,
  type ProfileSnapshot,
} from "./machine.js";
export {
  advanceParticipant,
  mayReenter,
  type ParticipantAction,
  type ParticipantOutcome,
  type ParticipantRow,
  type ParticipantStep,
  repositoryActionFor,
} from "./instance.js";
export {
  type OutgoingEffect,
  toOutgoing,
  type TriggerEvent,
  triggerLabel,
  triggerMatches,
} from "./transitions.js";
