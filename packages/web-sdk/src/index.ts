/**
 * `@polaris/web-sdk` — browser SDK for Polaris.
 *
 * Public v1 surface per `docs/architecture/10-sdk-standards.md`:
 *
 *   - `track(event, properties, options?)` -> Promise<string>
 *   - `identify(customerId, traits?)`
 *   - `reset(options?)`
 *   - `flush()` -> Promise<FlushResult>
 *
 * Hard rules baked in:
 *
 *   - No third-party cookies. No fingerprinting. No IP-based identity
 *     inference.
 *   - Identity persistence: first-party cookie -> localStorage mirror ->
 *     sessionStorage -> memory.
 *   - Event queue: IndexedDB preferred -> localStorage fallback ->
 *     memory fallback. Cookies are NEVER used for event queues.
 *   - First 15 seconds after construction use eager flush mode (100ms
 *     debounce). After that, steady mode flushes every 5 seconds.
 *   - pagehide / visibilitychange triggers an urgent flush via
 *     `sendBeacon` (with `fetch` keepalive fallback). Page-exit
 *     delivery is best-effort.
 *   - `event_id` is preserved across retries.
 *   - Queue priorities `low | normal | high`. Overflow drops oldest
 *     `low` first, then oldest `normal`, then oldest `high`.
 *   - Diagnostics are callback-only. The SDK does NOT emit automatic
 *     diagnostic events to Polaris in v1.
 *
 * Quickstart (async constructor, recommended):
 *
 *   ```ts
 *   import { PolarisWebSdk } from "@polaris/web-sdk";
 *
 *   const sdk = await PolarisWebSdk.create({
 *     endpoint: "https://ingest.polaris.internal/v1/events",
 *     apiKey: process.env.POLARIS_API_KEY!,
 *     source: { id: "checkout-app" },
 *   });
 *   await sdk.track("page.viewed", { path: location.pathname });
 *   ```
 *
 * @see docs/architecture/04-ingestion-and-sdks.md
 * @see docs/architecture/10-sdk-standards.md
 * @see docs/implementation/tasks/P3-002-web-sdk-identity-persistence.md
 * @see docs/implementation/tasks/P3-003-web-sdk-queue-transport.md
 */

export {
  CookieStore,
  DEFAULT_SESSION_INACTIVITY_MS,
  IdentityManager,
  LayeredIdentityStore,
  LocalStorageStore,
  MemoryStore,
  SessionStorageStore,
  WebStorageStore,
  type WebStorageStoreInputs,
} from "./identity/index.js";
export { ValidationError } from "./internal/validation.js";
export {
  drainLoaderQueue,
  INLINE_LOADER_SNIPPET,
  type DrainQueueOptions,
  type LoaderCommand,
  type LoaderQueue,
} from "./loader.js";
export {
  IndexedDbQueue,
  LayeredEventQueue,
  type LayeredEventQueueOptions,
  LocalStorageQueue,
  MemoryQueue,
  probeIndexedDb,
} from "./queue/index.js";
export { PolarisWebSdk } from "./sdk.js";
export { HttpsTransport, type HttpsTransportOptions, TransportError } from "./transport/index.js";
export type {
  CookieOptions,
  Diagnostic,
  DiagnosticCallbacks,
  DiagnosticKind,
  DropReason,
  EnqueueOutcome,
  EnvelopeIdentity,
  EventPriority,
  EventQueue,
  FlushResult,
  IdentifyTraits,
  IdentityCapability,
  IdentityDiagnostics,
  IdentityManagerOptions,
  IdentityStore,
  PersistedIdentity,
  QueueEntry,
  QueueLayer,
  QueuedEventPayload,
  ResetOptions,
  RetryPolicy,
  StorageLayer,
  TrackOptions,
  Transport,
  TransportEventResult,
  TransportMode,
  TransportResult,
  WebSdkOptions,
  WebSourceConfig,
} from "./types.js";
