/**
 * Public types for `@polaris/node-sdk`.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   - SDKs are thin transport + identity/session helpers, not analytics
 *     engines. The Node SDK does not enrich, attribute, resolve identity,
 *     call vendors, or own schema governance.
 *   - The public v1 surface is exactly `track`, `identify`, `reset`,
 *     `flush`, plus the Node-SDK-specific `close()` lifecycle.
 *   - SDKs perform only basic envelope/client-side validation. The ingester
 *     remains authoritative for event-specific schema validation.
 *   - Diagnostics are exposed via optional callbacks. SDKs do not emit
 *     automatic diagnostic events to Polaris in v1.
 *   - The Node SDK uses a memory queue by default. A queue adapter
 *     interface is exposed so durable backends (Redis, filesystem, custom)
 *     can plug in later. Only the interface and the memory adapter ship in
 *     v1 — the default memory queue does not survive process crashes.
 */

import type { Envelope } from "@polaris/shared-schemas";

/**
 * The shape of an event as it leaves `track()` and enters the queue.
 *
 * The Node SDK ships a *producer-side* envelope: `project_id`,
 * `environment`, trusted `source.id`, and `ingested_at` are stamped by the
 * ingester from the API key. We keep `project_id`/`environment`/`source` in
 * the optional fields here only because some operators run the SDK against
 * test scaffolding that does not stamp them — the canonical contract is
 * still "let the ingester own those fields."
 *
 * `event_id` is generated SDK-side as UUIDv7 and preserved across retries.
 */
export interface QueuedEvent {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly occurred_at: string;
  readonly source: Envelope["source"];
  readonly identity: Envelope["identity"];
  readonly context: Envelope["context"];
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consent?: Envelope["consent"];
  readonly privacy?: Envelope["privacy"];
}

/**
 * Identity inputs the caller may attach to a `track()` call. Anything not
 * supplied here falls back to the SDK's persistent identity state managed
 * by `identify()` / `reset()`.
 *
 * Per the Node SDK guidance in `04-ingestion-and-sdks.md`, identity values
 * are caller-supplied. The Node SDK does not infer attribution or identity
 * relationships.
 */
export interface IdentityOverrides {
  readonly anonymous_id?: string | null;
  readonly session_id?: string | null;
  readonly customer_id?: string | null;
  readonly device_id?: string | null;
}

/** Options accepted by `track()`. */
export interface TrackOptions {
  /** Override identity for this single event. */
  readonly identity?: IdentityOverrides;
  /** Optional `context` overrides merged on top of the SDK default context. */
  readonly context?: Partial<Envelope["context"]>;
  /** Producer-supplied occurrence timestamp (ISO 8601 UTC). Defaults to `now`. */
  readonly occurredAt?: Date | string;
  /** Optional `schema_version` for this event. Defaults to `1`. */
  readonly schemaVersion?: number;
  /** Optional consent/privacy metadata to attach to this event. */
  readonly consent?: Envelope["consent"];
  readonly privacy?: Envelope["privacy"];
}

/** Options accepted by `reset()`. */
export interface ResetOptions {
  /**
   * Default `true` — rotate `anonymous_id` along with `customer_id` /
   * `session_id`. Set `false` to keep anonymous continuity (matches the
   * Web SDK shape so application code reads the same on both runtimes).
   */
  readonly anonymous?: boolean;
}

/**
 * Optional identity traits attached by `identify()`. Traits are not part of
 * the canonical envelope in v1 — they ride alongside as caller-defined
 * metadata that subsequent events may surface in `properties`. The SDK
 * does not invent identity links from traits.
 */
export type IdentifyTraits = Readonly<Record<string, unknown>>;

/** Result of a single transport flush attempt. */
export interface FlushResult {
  /** Events successfully transmitted to the ingester. */
  readonly delivered: number;
  /** Events still queued (e.g. failed batches kept for the next attempt). */
  readonly queued: number;
  /** Events dropped during this flush (terminal failures, overflow during the flush). */
  readonly dropped: number;
}

/** Diagnostic reasons the SDK uses with optional callbacks. */
export type DropReason =
  | "queue_overflow"
  | "permanent_failure"
  | "shutdown_timeout"
  | "validation_failed";

export type DiagnosticKind =
  | "queue_pressure"
  | "queue_overflow"
  | "retry"
  | "flush"
  | "validation_failed"
  | "shutdown_timeout"
  | "transport_error";

/** Structured diagnostic record passed to `onDiagnostic`. */
export interface Diagnostic {
  readonly kind: DiagnosticKind;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Optional callbacks exposed to applications. None are required. SDKs do
 * not emit automatic diagnostic events to Polaris in v1; this is the
 * extension point operators wire into their own logging/metrics.
 */
export interface DiagnosticCallbacks {
  onError?: (error: Error) => void;
  onDrop?: (event: QueuedEvent, reason: DropReason) => void;
  onRetry?: (event: QueuedEvent, attempt: number, error: Error) => void;
  onFlush?: (result: FlushResult) => void;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

/**
 * Queue adapter interface.
 *
 * Implementations may be in-memory (the default ships in
 * `src/queue/memory.ts`) or backed by durable stores (Redis, filesystem,
 * application outbox tables). Only the interface and memory adapter ship
 * in v1 per the task card.
 *
 * Ordering: callers (the SDK core) treat the queue as FIFO. Adapters that
 * need to reorder for delivery priority should still hand back the oldest
 * eligible event from `peek()`/`drain()`.
 *
 * Crash durability: the default memory adapter does NOT survive process
 * crashes. Operators running critical backend producers should plug in a
 * durable adapter or emit from their own reliable outbox.
 */
export interface QueueAdapter {
  /**
   * Append an event to the tail of the queue. Returns `true` when the
   * event was accepted, `false` when the queue is full and rejected the
   * event (the SDK core will then call `onDrop` with `queue_overflow`).
   *
   * Implementations may also evict older events instead of rejecting; in
   * that case they must call back into the supplied `onOverflow` hook so
   * the SDK can emit `onDrop` diagnostics consistently.
   */
  enqueue(event: QueuedEvent): Promise<boolean> | boolean;
  /** Number of events currently in the queue (best-effort for durable backends). */
  size(): Promise<number> | number;
  /**
   * Remove and return up to `max` events from the head. The returned
   * events stay owned by the caller until either delivered (and dropped
   * via `ack`) or returned via `requeue`.
   */
  drain(max: number): Promise<QueuedEvent[]> | QueuedEvent[];
  /**
   * Return events back to the head of the queue (used after a retryable
   * transport failure so `event_id` is preserved across the retry).
   */
  requeue(events: readonly QueuedEvent[]): Promise<void> | void;
  /** Optional hook called when the SDK closes — adapters may flush durable state. */
  close?(): Promise<void> | void;
}

/**
 * HTTP transport interface. The SDK ships an HTTPS POST transport
 * (`src/transport/https.ts`) that uses Node's built-in `https` client with
 * keep-alive. Operators may inject a custom transport for testing or for
 * non-HTTPS gateways inside a private network.
 */
export interface Transport {
  /**
   * Send a batch of events to the ingester. Returns a `TransportResult`
   * describing per-event acceptance. Throws only for transport-layer
   * failures (network errors, 5xx, timeouts) — the SDK core decides
   * whether to retry based on the thrown error class.
   */
  send(events: readonly QueuedEvent[]): Promise<TransportResult>;
  /** Optional teardown hook called from `close()`. */
  close?(): Promise<void> | void;
}

/**
 * Per-event transport result.
 *
 * The ingester returns partial-acceptance batch results per
 * `04-ingestion-and-sdks.md`. Permanent rejections (4xx-class reasons such
 * as `schema_validation_failed`) must not be retried; transient failures
 * may be retried with exponential backoff and jitter.
 */
export interface TransportEventResult {
  readonly event_id: string;
  readonly status: "accepted" | "rejected";
  /** Machine-readable reason code when `status === "rejected"`. */
  readonly reason?: string;
  /** Whether this rejection is retryable (transient) per the transport layer. */
  readonly retryable?: boolean;
}

export interface TransportResult {
  readonly accepted: readonly TransportEventResult[];
  readonly rejected: readonly TransportEventResult[];
}

/** Source metadata that the SDK stamps on every event. */
export interface SourceConfig {
  readonly type: Envelope["source"]["type"];
  readonly id: string;
  readonly sdkVersion?: string;
}

/** Retry policy for transient transport failures. */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Multiplier applied per attempt (e.g. 2 → exponential doubling). */
  readonly backoffMultiplier: number;
  /** Maximum jitter ratio (0..1). Per-attempt jitter ∈ [0, jitterRatio]. */
  readonly jitterRatio: number;
}

/** Constructor options for the SDK. */
export interface PolarisSdkOptions {
  /** Polaris ingestion endpoint, e.g. `https://ingest.polaris.internal/v1/events`. */
  readonly endpoint: string;
  /** API key bound to project/environment/source by the control plane. */
  readonly apiKey: string;
  /** Source metadata stamped on every event. */
  readonly source: SourceConfig;
  /** Optional default context merged into every event. */
  readonly defaultContext?: Partial<Envelope["context"]>;
  /** Maximum events held in the in-memory queue. Default 10_000. */
  readonly maxQueueSize?: number;
  /** Maximum batch size per flush. Default 50. */
  readonly batchSize?: number;
  /** Steady-state flush interval. Default 5_000ms. Set to `0` to disable. */
  readonly flushIntervalMs?: number;
  /** Per-attempt HTTP timeout in ms. Default 10_000ms. */
  readonly requestTimeoutMs?: number;
  /** Custom retry policy. Defaults to exponential backoff with jitter. */
  readonly retry?: Partial<RetryPolicy>;
  /** Optional persistent identity defaults (anonymous_id, etc). */
  readonly identity?: IdentityOverrides;
  /** Optional diagnostic callbacks. */
  readonly diagnostics?: DiagnosticCallbacks;
  /** Inject a custom queue adapter (defaults to bounded memory queue). */
  readonly queue?: QueueAdapter;
  /** Inject a custom transport (defaults to HTTPS POST with keep-alive). */
  readonly transport?: Transport;
  /**
   * Default `false`. When `true`, the SDK registers `SIGTERM`/`SIGINT`
   * handlers that call `close()`. Opt-in only per the task card.
   */
  readonly autoFlushOnShutdown?: boolean;
  /**
   * Default `5_000`ms. Timeout for the shutdown-time drain inside `close()`.
   * The SDK must not block process exit indefinitely.
   */
  readonly shutdownTimeoutMs?: number;
}
