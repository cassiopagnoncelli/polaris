/**
 * `@polaris/processor-attribution-engine-v1` — public module barrel.
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
  buildAttributionEngineApp,
  type BuildAppOptions,
  type BuiltAttributionEngineApp,
} from "./app.js";
export {
  PROCESSOR_SERVICE_NAME,
  attributionEngineConfigSchema,
  attributionEngineEnvKeys,
  attributionEngineEnvSchema,
  loadAttributionEngineConfig,
  type AttributionEngineConfig,
  type AttributionEngineRuntimeConfig,
} from "./config.js";
export {
  createRuntime,
  type AttributionEngineRuntime,
  type AttributionEngineRuntimeDeps,
  type AttributionEventEnvelope,
  type AttributionEventName,
} from "./runtime.js";
export {
  buildFirstTouchAssignedEnvelope,
  buildLastTouchAssignedEnvelope,
  buildTouchpointCapturedEnvelope,
  type AttributionEventProperties,
  type FirstTouchAssignedProperties,
  type LastTouchAssignedProperties,
  type TouchpointCapturedProperties,
} from "./emit.js";
export {
  InMemoryTouchpointStore,
  buildDeltaRecord,
  buildFirstObservationRecord,
  buildSameTupleRecord,
  type TouchpointStore,
} from "./store.js";
export {
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  PRIMARY_IDENTIFIER_KINDS,
  buildTouchpointStoreKey,
  campaignTuplesEqual,
  decideAttribution,
  deriveTouchpointId,
  isCampaignEmpty,
  normaliseCampaign,
  resolvePrimaryIdentifier,
  type AttributionDecision,
  type CampaignTuple,
  type PrimaryIdentifier,
  type PrimaryIdentifierKind,
  type TouchpointChainRecord,
} from "./transform.js";
export type {
  AnalyticsEventEnvelope,
  AttributionEventCampaign,
  AttributionEventContext,
  AttributionEventIdentity,
  AttributionEventSource,
} from "./types.js";
