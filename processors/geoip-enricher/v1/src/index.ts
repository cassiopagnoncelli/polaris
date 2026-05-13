/**
 * `@polaris/processor-geoip-enricher-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildGeoipEnricherApp`, `createRuntime`,
 * `decideEnrichment`, `IPLookup` adapters, config loader) so tests,
 * smoke harnesses, and the future replay executor (P7-003) can drive
 * the processor without forking the process.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 */

export {
  buildGeoipEnricherApp,
  type BuildAppOptions,
  type BuiltGeoipEnricherApp,
} from "./app.js";
export {
  PROCESSOR_SERVICE_NAME,
  geoipEnricherConfigSchema,
  geoipEnricherEnvKeys,
  geoipEnricherEnvSchema,
  loadGeoipEnricherConfig,
  type GeoipEnricherConfig,
  type GeoipEnricherRuntimeConfig,
} from "./config.js";
export {
  buildGeoipEnvelope,
  type BuildGeoipEnvelopeOptions,
  type GeoipEnvelope,
  type GeoipEventName,
} from "./emit.js";
export { hashIp, parseIp } from "./ip.js";
export {
  fromFixture,
  InMemoryIPLookup,
  NoOpIPLookup,
  type GeoResult,
  type IPLookup,
} from "./lookup.js";
export {
  createRuntime,
  type GeoipEnricherRuntime,
  type GeoipEnricherRuntimeDeps,
} from "./runtime.js";
export {
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  SOURCE_NO_IP,
  SOURCE_NO_LOOKUP,
  decideEnrichment,
  decisionToProperties,
  type EnrichmentDecision,
} from "./transform.js";
export type {
  RawEventContext,
  RawEventEnvelope,
  RawEventIdentity,
  RawEventSource,
} from "./types.js";
