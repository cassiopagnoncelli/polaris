/**
 * `@polaris/processor-attribution-engine-v3` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildAttributionEngineApp`, `createRuntime`,
 * pure transform, store, emit helpers, config loader) so tests, smoke
 * harnesses, and the future replay executor can drive the processor
 * without forking the process.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 */

export {
  type BuildAppOptions,
  type BuiltAttributionEngineApp,
  buildAttributionEngineApp,
} from "./app.js";
export {
  type AttributionEngineConfig,
  type AttributionEngineRuntimeConfig,
  attributionEngineConfigSchema,
  attributionEngineEnvKeys,
  attributionEngineEnvSchema,
  loadAttributionEngineConfig,
  PROCESSOR_SERVICE_NAME,
} from "./config.js";
export {
  type AttributionEventProperties,
  buildFirstTouchAssignedEnvelope,
  buildLastTouchAssignedEnvelope,
  buildTouchpointCapturedEnvelope,
  type FirstTouchAssignedProperties,
  type LastTouchAssignedProperties,
  type TouchpointCapturedProperties,
} from "./emit.js";
export {
  type AttributionEngineRuntime,
  type AttributionEngineRuntimeDeps,
  type AttributionEventEnvelope,
  type AttributionEventName,
  createRuntime,
} from "./runtime.js";
export {
  buildDeltaRecord,
  buildFirstObservationRecord,
  buildSameTupleRecord,
  InMemoryTouchpointStore,
  type TouchpointStore,
} from "./store.js";
export {
  type AttributionDecision,
  buildTouchpointStoreKey,
  type CampaignTuple,
  campaignTuplesEqual,
  decideAttribution,
  deriveTouchpointId,
  isCampaignEmpty,
  normaliseCampaign,
  PRIMARY_IDENTIFIER_KINDS,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  type PrimaryIdentifier,
  type PrimaryIdentifierKind,
  resolvePrimaryIdentifier,
  type TouchpointChainRecord,
} from "./transform.js";
export type {
  AnalyticsEventEnvelope,
  AttributionEventCampaign,
  AttributionEventContext,
  AttributionEventIdentity,
  AttributionEventSource,
} from "./types.js";
