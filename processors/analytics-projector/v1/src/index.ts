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
  buildAnalyticsProjectorApp,
  type BuildAppOptions,
  type BuiltAnalyticsProjectorApp,
} from "./app.js";
export {
  PROCESSOR_SERVICE_NAME,
  analyticsProjectorConfigSchema,
  analyticsProjectorEnvKeys,
  analyticsProjectorEnvSchema,
  loadAnalyticsProjectorConfig,
  type AnalyticsProjectorConfig,
  type AnalyticsProjectorRuntimeConfig,
} from "./config.js";
export {
  createRuntime,
  type AnalyticsProjectorRuntime,
  type AnalyticsProjectorRuntimeDeps,
} from "./runtime.js";
export {
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  transformToAnalyticsEvent,
  type AnalyticsEventEnvelope,
  type ProcessorStamp,
  type RawEventEnvelope,
  type RawEventIdentity,
  type RawEventSource,
  type TransformOptions,
} from "./transform.js";
