/**
 * `@polaris/node-sdk` — thin transport + identity helpers for backend producers.
 *
 * Public v1 surface (per `docs/architecture/10-sdk-standards.md`):
 *
 * ```ts
 * import { PolarisNodeSdk } from "@polaris/node-sdk";
 *
 * const polaris = new PolarisNodeSdk({
 *   endpoint: "https://ingest.polaris.internal/v1/events",
 *   apiKey: process.env.POLARIS_API_KEY!,
 *   source: { type: "backend", id: "checkout-api" },
 * });
 *
 * await polaris.track("payment.approved", { amount: 12990, currency: "BRL" });
 * await polaris.flush();
 * await polaris.close();
 * ```
 *
 * Hard rules baked in:
 *
 *   - SDK is thin: transport + identity/session helpers and nothing else.
 *     No autocapture, attribution, vendor mappings, business workflows,
 *     or schema governance.
 *   - `event_id` is generated SDK-side as UUIDv7 and preserved across
 *     retries.
 *   - Default queue is bounded in-memory. The `QueueAdapter` interface
 *     allows durable backends (Redis, filesystem, custom) to plug in
 *     later. Operators must not rely on the default queue surviving
 *     process crashes.
 *   - Explicit `flush()` and `close()` lifecycle. No process signal
 *     handlers by default; `autoFlushOnShutdown` is opt-in only.
 *   - Client-side validation is limited to basic envelope/client shape.
 *     The ingester remains authoritative for event-specific schemas.
 *   - Diagnostics use optional callbacks. The SDK does not emit
 *     automatic diagnostic events to Polaris in v1.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md
 * @see docs/architecture/10-sdk-standards.md
 * @see docs/implementation/tasks/P3-001-node-sdk-core.md
 */

export { ValidationError } from "./internal/validation.js";
export { MemoryQueueAdapter, type MemoryQueueOptions } from "./queue/index.js";
export { PolarisNodeSdk } from "./sdk.js";
export { HttpsTransport, type HttpsTransportOptions, TransportError } from "./transport/index.js";
export type {
  Diagnostic,
  DiagnosticCallbacks,
  DiagnosticKind,
  DropReason,
  FlushResult,
  IdentifyTraits,
  IdentityOverrides,
  PolarisSdkOptions,
  QueueAdapter,
  QueuedEvent,
  ResetOptions,
  RetryPolicy,
  SourceConfig,
  TrackOptions,
  Transport,
  TransportEventResult,
  TransportResult,
} from "./types.js";
