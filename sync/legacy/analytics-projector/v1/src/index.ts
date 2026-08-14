/**
 * `@polaris/processor-analytics-projector-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildAnalyticsProjectorApp`,
 * `createRuntime`, `transformToAnalyticsEvent`, config loader) so tests,
 * smoke harnesses, and the future replay executor (P7-003) can drive
 * the processor without forking the process.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 */

export {
  type BuildAppOptions,
  type BuiltAnalyticsProjectorApp,
  buildAnalyticsProjectorApp,
} from "./app.js";
export {
  type AnalyticsProjectorConfig,
  type AnalyticsProjectorRuntimeConfig,
  analyticsProjectorConfigSchema,
  analyticsProjectorEnvKeys,
  analyticsProjectorEnvSchema,
  loadAnalyticsProjectorConfig,
  PROCESSOR_SERVICE_NAME,
} from "./config.js";
export {
  type AnalyticsProjectorRuntime,
  type AnalyticsProjectorRuntimeDeps,
  createRuntime,
} from "./runtime.js";
export {
  type AnalyticsEventEnvelope,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  type ProcessorStamp,
  type RawEventEnvelope,
  type RawEventIdentity,
  type RawEventSource,
  type TransformOptions,
  transformToAnalyticsEvent,
} from "./transform.js";
