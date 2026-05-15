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
  type BuildAppOptions,
  type BuiltGeoipEnricherApp,
  buildGeoipEnricherApp,
} from "./app.js";
export {
  type GeoipEnricherConfig,
  type GeoipEnricherRuntimeConfig,
  geoipEnricherConfigSchema,
  geoipEnricherEnvKeys,
  geoipEnricherEnvSchema,
  loadGeoipEnricherConfig,
  PROCESSOR_SERVICE_NAME,
} from "./config.js";
export {
  type BuildGeoipEnvelopeOptions,
  buildGeoipEnvelope,
  type GeoipEnvelope,
  type GeoipEventName,
} from "./emit.js";
export { hashIp, parseIp } from "./ip.js";
export {
  fromFixture,
  type GeoResult,
  InMemoryIPLookup,
  type IPLookup,
  NoOpIPLookup,
} from "./lookup.js";
export {
  createRuntime,
  type GeoipEnricherRuntime,
  type GeoipEnricherRuntimeDeps,
} from "./runtime.js";
export {
  decideEnrichment,
  decisionToProperties,
  type EnrichmentDecision,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  SOURCE_NO_IP,
  SOURCE_NO_LOOKUP,
} from "./transform.js";
export type {
  RawEventContext,
  RawEventEnvelope,
  RawEventIdentity,
  RawEventSource,
} from "./types.js";
