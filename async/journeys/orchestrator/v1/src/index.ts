/**
 * Journey orchestrator v1.
 *
 * Consumes `resolved.events` and `profile.events`, walks participants
 * through the graphs in `definitions/journeys/`, and emits `journey.*` onto the
 * profile plane. It makes no vendor calls: an action's event travels the
 * ordinary destination path like any other.
 *
 * What a journey MEANS — the machine, one participation's rules, trigger
 * matching and the shape of an emitted event — is
 * `@polaris/engage-journeys`. This package is the shell: config, a Postgres
 * repository, a consumer, a producer and a sweep timer. The library's
 * surface is re-exported here so the CLI's `journeys sweep` reaches one
 * package rather than two.
 */

export {
  type AdvanceResult,
  advance,
  evaluateJourneyPredicate,
  isForbiddenTrigger,
  type JourneyEffect,
  mayReenter,
  type OutgoingEffect,
  type ParticipantRow,
  type Participation,
  type ProfileSnapshot,
  triggerMatches,
} from "@polaris/engage-journeys";
export {
  createKyselyJourneyRepository,
  type EnterInput,
  type JourneyRepository,
} from "./repository.js";
export {
  applyToRepository,
  type HandleEventDeps,
  type HandleEventResult,
  handleEvent,
  type IncomingEvent,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
} from "./runtime.js";
export { definitionKey, type SweepInput, type SweepResult, sweep } from "./sweep.js";
export { buildJourneyOrchestratorApp } from "./app.js";
export {
  type JourneyOrchestratorRuntimeConfig,
  loadJourneyOrchestratorConfig,
} from "./config.js";
