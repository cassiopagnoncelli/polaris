/**
 * `@polaris/processor-sessionizer-v1` — public module barrel.
 *
 * The binary entry point lives in `./main.ts`. This barrel exposes the
 * composable building blocks (`buildSessionizerApp`, `createRuntime`,
 * pure transform, store, emit helpers, config loader) so tests, smoke
 * harnesses, and the future replay executor can drive the processor
 * without forking the process.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 */

export {
  type BuildAppOptions,
  type BuiltSessionizerApp,
  buildSessionizerApp,
} from "./app.js";
export {
  loadSessionizerConfig,
  PROCESSOR_SERVICE_NAME,
  type SessionizerConfig,
  type SessionizerRuntimeConfig,
  sessionizerConfigSchema,
  sessionizerEnvKeys,
  sessionizerEnvSchema,
} from "./config.js";
export {
  buildSessionEndedEnvelope,
  buildSessionStartedEnvelope,
  type SessionEndedProperties,
  type SessionStartedProperties,
} from "./emit.js";
export {
  createRuntime,
  OUTPUT_STREAM_FAMILY,
  type SessionEventEnvelope,
  type SessionEventName,
  type SessionizerRuntime,
  type SessionizerRuntimeDeps,
} from "./runtime.js";
export {
  buildContinuedRecord,
  buildOpenedRecord,
  InMemorySessionStore,
  type SessionStore,
} from "./store.js";
export {
  buildSessionStoreKey,
  DEFAULT_INACTIVITY_SECONDS,
  decideSession,
  deriveSessionId,
  PRIMARY_IDENTIFIER_KINDS,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  type PrimaryIdentifier,
  type PrimaryIdentifierKind,
  resolvePrimaryIdentifier,
  type SessionDecision,
  type SessionRecord,
} from "./transform.js";
export type {
  RawEventEnvelope,
  RawEventIdentity,
  RawEventSource,
} from "./types.js";
