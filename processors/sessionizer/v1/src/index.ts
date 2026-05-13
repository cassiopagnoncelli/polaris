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
  buildSessionizerApp,
  type BuildAppOptions,
  type BuiltSessionizerApp,
} from "./app.js";
export {
  PROCESSOR_SERVICE_NAME,
  loadSessionizerConfig,
  sessionizerConfigSchema,
  sessionizerEnvKeys,
  sessionizerEnvSchema,
  type SessionizerConfig,
  type SessionizerRuntimeConfig,
} from "./config.js";
export {
  OUTPUT_TOPIC_FAMILY,
  createRuntime,
  type SessionizerRuntime,
  type SessionizerRuntimeDeps,
  type SessionEventEnvelope,
  type SessionEventName,
} from "./runtime.js";
export {
  buildSessionEndedEnvelope,
  buildSessionStartedEnvelope,
  type SessionEndedProperties,
  type SessionStartedProperties,
} from "./emit.js";
export {
  InMemorySessionStore,
  buildContinuedRecord,
  buildOpenedRecord,
  type SessionStore,
} from "./store.js";
export {
  DEFAULT_INACTIVITY_SECONDS,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  PRIMARY_IDENTIFIER_KINDS,
  buildSessionStoreKey,
  decideSession,
  deriveSessionId,
  resolvePrimaryIdentifier,
  type PrimaryIdentifier,
  type PrimaryIdentifierKind,
  type SessionDecision,
  type SessionRecord,
} from "./transform.js";
export type {
  RawEventEnvelope,
  RawEventIdentity,
  RawEventSource,
} from "./types.js";
