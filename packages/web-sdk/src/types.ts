/**
 * Public types for `@polaris/web-sdk`.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   - SDKs are thin transport + identity/session helpers, not analytics
 *     engines. The Web SDK does not enrich, attribute, resolve identity,
 *     call vendors, or own schema governance.
 *   - Browser identity persistence is layered: first-party cookie ->
 *     localStorage mirror -> sessionStorage fallback -> in-memory fallback.
 *   - Browser queue persistence is layered: IndexedDB preferred ->
 *     localStorage fallback -> in-memory fallback. Cookies are NEVER used
 *     for event queues.
 *   - No third-party cookies. No fingerprinting. No IP-based identity
 *     inference.
 *   - Sessions rotate after 30 minutes of inactivity. Campaign / click
 *     changes do NOT rotate sessions — they are captured as event context,
 *     not identity.
 *   - `reset()` defaults to stronger user separation: clears customer_id,
 *     rotates session_id, rotates anonymous_id. `reset({ anonymous: false
 *     })` keeps anonymous_id.
 *   - The SDK records the storage layer it landed on as diagnostic context
 *     so the downstream identity resolver can treat storage layer as
 *     evidence quality.
 *   - Flush lifecycle:
 *       0-15s after SDK init   -> eager flush mode (100ms debounce)
 *       after 15s              -> steady batch mode (default 5s interval)
 *       pagehide / manual flush -> urgent flush (sendBeacon / keepalive)
 *   - Page-exit delivery is best-effort, NOT guaranteed.
 *
 * P3-003 ships the queue, transport, retry coordinator, lifecycle
 * controller, and the real `track()` + `flush()` semantics on top of the
 * P3-002 identity layer.
 */

import type { Envelope } from "@polaris/shared-schemas";

/**
 * Layers the SDK considers when reading/writing identity.
 *
 * Order in the array is the doctrinal fallback chain:
 *   first-party cookie  -> stronger browser continuity signal
 *   localStorage mirror -> normal browser continuity signal
 *   sessionStorage      -> weaker session-only signal
 *   in-memory           -> weakest transient signal
 *
 * The identity resolver downstream treats this enum as an evidence-quality
 * signal (see `docs/architecture/10-sdk-standards.md` § Identity Resolution
 * Coupling).
 */
export type StorageLayer = "cookie" | "localStorage" | "sessionStorage" | "memory";

/**
 * Result of capability detection at SDK init. Recorded for diagnostics and
 * surfaced via {@link IdentityManager.getDiagnostics}. `available` is the
 * list of layers the SDK successfully probed at startup; `primary` is the
 * highest-priority layer actually selected for writes. `degraded` is true
 * when the SDK ended up on an in-memory or session-only layer because the
 * stronger options were unavailable (typical for ad WebViews / locked-down
 * Safari modes / private browsing).
 */
export interface IdentityCapability {
  readonly available: readonly StorageLayer[];
  readonly primary: StorageLayer;
  readonly degraded: boolean;
  /** True when running in a detected WebView / in-app browser. */
  readonly webview: boolean;
  /** True when the page is loaded over `https:`. Drives the Secure cookie flag. */
  readonly secureContext: boolean;
}

/** Configuration for the cookie layer. Defaults follow the architecture doc. */
export interface CookieOptions {
  /**
   * Cookie name used for the identity record. Defaults to `polaris_id`. The
   * SDK uses a single cookie and JSON-encodes the identity payload inside
   * it so we do not pollute the cookie jar with one cookie per field.
   */
  readonly name?: string;
  /**
   * Cookie `Domain` attribute. Leave unset to scope to the current host
   * (browser default). Set to `.example.com` to share identity across
   * subdomains.
   */
  readonly domain?: string;
  /**
   * Cookie `Path` attribute. Defaults to `/`. Only set this when you
   * deliberately want to scope identity to a subpath.
   */
  readonly path?: string;
  /**
   * Cookie `Max-Age` in seconds. Defaults to 13 months (matches the GDPR
   * cookie convention used by most analytics SDKs).
   */
  readonly maxAgeSeconds?: number;
  /**
   * Cookie `SameSite` attribute. Defaults to `Lax`. We intentionally do
   * not expose `None` as a default — third-party cookie use is forbidden.
   */
  readonly sameSite?: "Lax" | "Strict";
  /**
   * When `undefined` (the default) the SDK adds `Secure` if and only if
   * the page is loaded over HTTPS. Set to `true` to force `Secure`, set to
   * `false` to suppress it (only useful for local HTTP development).
   */
  readonly secure?: boolean;
}

/** Storage interface every identity layer implements. */
export interface IdentityStore {
  /** Stable label used in diagnostics. */
  readonly layer: StorageLayer;
  /**
   * Synchronous availability check. Stores that talk to the DOM probe
   * the relevant APIs in `isAvailable`; the layered store calls this once
   * at construction and a second time before each operation so a tab that
   * loses storage access (e.g. iOS Safari evicting site data) is detected
   * without crashing the SDK.
   */
  isAvailable(): boolean;
  /** Read the identity record. Returns null when nothing is stored. */
  read(): PersistedIdentity | null;
  /** Write the identity record. Returns false if the underlying store rejected the write. */
  write(identity: PersistedIdentity): boolean;
  /** Clear the identity record. Returns false if the underlying store rejected the clear. */
  clear(): boolean;
}

/**
 * Identity record shape persisted to whichever storage layer is available.
 *
 * `last_activity_at` is an epoch millisecond timestamp the SDK uses for
 * 30-minute inactivity session rotation. Storing it next to the IDs keeps
 * a layered read self-contained — a fresh tab on a different storage layer
 * can still rotate correctly without consulting other layers.
 *
 * `storage_layer` is the layer the record was last written through. The
 * SDK uses this for diagnostics and to surface evidence quality to the
 * downstream identity resolver.
 */
export interface PersistedIdentity {
  readonly anonymous_id: string;
  readonly session_id: string;
  readonly customer_id: string | null;
  /** Epoch millis of the most recent SDK activity that touched identity. */
  readonly last_activity_at: number;
  /** Layer this snapshot was written through. */
  readonly storage_layer: StorageLayer;
}

/** Identity fields surfaced to event envelopes. */
export type EnvelopeIdentity = Envelope["identity"];

/** Options accepted by `reset()`. */
export interface ResetOptions {
  /**
   * Default `true` — rotate `anonymous_id` along with `customer_id` /
   * `session_id`. Set `false` to keep anonymous continuity (matches the
   * Node SDK shape so application code reads the same on both runtimes).
   */
  readonly anonymous?: boolean;
}

/** Optional identity traits attached by `identify()`. Mirrors the Node SDK. */
export type IdentifyTraits = Readonly<Record<string, unknown>>;

/** Options for the layered identity store / manager. */
export interface IdentityManagerOptions {
  /** Configuration for the cookie layer. */
  readonly cookie?: CookieOptions;
  /**
   * Override the storage-layer chain considered at startup. The first
   * available layer in this list wins. Defaults to the doctrinal order:
   * `["cookie", "localStorage", "sessionStorage", "memory"]`.
   */
  readonly storageOrder?: readonly StorageLayer[];
  /**
   * Session inactivity timeout in milliseconds. Defaults to 30 minutes,
   * which matches the architecture doc. The Web SDK does not rotate
   * sessions on campaign or click-id changes — those are event context.
   */
  readonly sessionInactivityMs?: number;
  /**
   * Optional `Date.now`-style clock injected for tests. Production code
   * uses the system clock; tests pin time to assert inactivity-rotation
   * timing without `vi.useFakeTimers`.
   */
  readonly now?: () => number;
  /**
   * Optional ID generator. Tests can inject deterministic IDs; production
   * uses UUIDv7 with a stable `anon_` / `sess_` prefix.
   */
  readonly idGenerator?: (prefix: "anon" | "sess") => string;
  /**
   * Optional document/window pair injected for tests in non-DOM contexts
   * (the package is browser-targeted; happy-dom supplies these in tests).
   * If omitted, the SDK reads from `globalThis`.
   */
  readonly document?: Document | undefined;
  readonly window?: Window | undefined;
}

/**
 * Diagnostic snapshot exposed via {@link IdentityManager.getDiagnostics}.
 *
 * The Web SDK does NOT emit automatic diagnostic events to Polaris in v1
 * (per `10-sdk-standards.md`). This snapshot exists so application code
 * can read storage-layer fallback state, log it locally, or forward it
 * via an opt-in diagnostic stream wired up in P3-003.
 */
export interface IdentityDiagnostics {
  readonly capability: IdentityCapability;
  /** Layer the last write actually landed on. Equals `capability.primary` after a successful write. */
  readonly currentLayer: StorageLayer;
  /** Epoch millis of the most recent identity touch. */
  readonly lastActivityAt: number;
}

// =====================================================================
// Queue + transport + lifecycle types (P3-003)
// =====================================================================

/**
 * Queue persistence layers for events.
 *
 * Per `docs/architecture/10-sdk-standards.md` § Web SDK Queue Model:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * Cookies are NEVER used for event queues. Order in the array is the
 * doctrinal fallback chain: IndexedDB first (large quota, async,
 * structured), then localStorage (5-10 MB, sync, string-only), then
 * memory (transient — events lost on navigation).
 */
export type QueueLayer = "indexeddb" | "localstorage" | "memory";

/** Local delivery priority. Affects retention under overflow only. */
export type EventPriority = "low" | "normal" | "high";

/**
 * The shape of an event as it leaves `track()` and enters the queue.
 *
 * Per `docs/architecture/01-event-contract.md`, `project_id`,
 * `environment`, trusted `source.id`, and `ingested_at` are stamped by the
 * ingester from the API key — producers do not supply them. The Web SDK
 * keeps the produced envelope minimal so it survives a round-trip through
 * IndexedDB / localStorage as plain JSON.
 *
 * `event_id` is generated SDK-side as UUIDv7 and preserved across retries.
 */
export interface QueuedEventPayload {
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
 * A queue entry combining the canonical event payload with local
 * delivery-only metadata. Local metadata is NOT sent to the ingester — it
 * exists only to support retry, priority overflow, and diagnostics.
 */
export interface QueueEntry {
  readonly payload: QueuedEventPayload;
  readonly priority: EventPriority;
  readonly attempts: number;
  /** Epoch millis when the SDK first enqueued the event. */
  readonly enqueued_at: number;
}

/**
 * Outcome of an `enqueue()` call.
 *
 *   - `accepted`: the entry landed in the queue.
 *   - `accepted_with_drops`: the entry landed, but other entries were
 *     evicted to make room (priority-overflow eviction). The `dropped`
 *     array lists the evicted entries so the SDK can emit `onDrop`
 *     diagnostics.
 *   - `rejected`: the queue is full and the new entry could not displace
 *     anything (e.g. priority too low, queue full of higher priorities).
 *     `track()` does NOT throw on rejection — the caller emits `onDrop`
 *     with reason `queue_overflow` and continues.
 */
export type EnqueueOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "accepted_with_drops"; readonly dropped: readonly QueueEntry[] }
  | { readonly status: "rejected" };

/**
 * Queue adapter interface for the Web SDK.
 *
 * Implementations may use IndexedDB (the preferred async layer),
 * localStorage (the fallback synchronous layer), or memory (the last
 * resort).
 *
 * Ordering rules:
 *
 *   - `drain(max)` returns up to `max` entries from the head (oldest first
 *     within a priority bucket, but the layered queue always drains in
 *     enqueue order).
 *   - On overflow, the queue drops oldest `low` first, then oldest
 *     `normal`, then oldest `high`. The new entry is admitted only if a
 *     lower-or-equal-priority entry exists to evict.
 *
 * Async-only API: the IndexedDB-backed implementation is inherently async,
 * so the interface unifies on Promises even when the underlying layer
 * (memory, localStorage) is synchronous. This keeps the SDK core simple.
 */
export interface EventQueue {
  /** Layer label, e.g. `"indexeddb"`, used for diagnostics. */
  readonly layer: QueueLayer;
  /**
   * Append an event to the tail of the queue. Returns an outcome that
   * describes whether the event was accepted and what (if anything) was
   * evicted under priority overflow.
   */
  enqueue(entry: QueueEntry): Promise<EnqueueOutcome>;
  /** Number of events currently in the queue. */
  size(): Promise<number>;
  /**
   * Remove and return up to `max` events from the head. Returned events
   * stay owned by the caller until the caller either commits delivery (and
   * discards them) or returns them via `requeue` after a transient failure.
   */
  drain(max: number): Promise<QueueEntry[]>;
  /**
   * Return events back to the head of the queue (used after a retryable
   * transport failure so `event_id` is preserved across retries). The
   * supplied entries should be the same `event_id`s previously drained;
   * implementations may increment `attempts` here or accept pre-incremented
   * entries from the caller.
   */
  requeue(entries: readonly QueueEntry[]): Promise<void>;
  /** Drain everything for sendBeacon-style urgent flushes. */
  drainAll(): Promise<QueueEntry[]>;
  /** Optional hook called when the SDK shuts down. */
  close?(): Promise<void>;
}

/**
 * Per-event ingester response entry. The ingester returns partial-batch
 * acceptance — some events accepted, some rejected by `event_id` — and the
 * retry coordinator decides retry vs drop based on `retryable`.
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

/**
 * Transport mode hint. Steady-state uses `fetch` (or `fetch` with
 * keepalive). Page-exit uses `sendBeacon` when available with a `fetch`
 * keepalive fallback. The transport layer picks based on the mode the
 * lifecycle controller passes in.
 */
export type TransportMode = "steady" | "urgent";

/**
 * Transport interface. The SDK ships an HTTPS POST transport
 * (`src/transport/https.ts`) that uses `fetch` for steady-state and
 * `navigator.sendBeacon` (with `fetch` keepalive fallback) for urgent
 * page-exit flushes.
 *
 * Implementations should throw a `TransportError`-shaped exception for
 * transport-layer failures (network errors, 5xx, timeouts) — the retry
 * coordinator decides whether to retry based on the thrown error class.
 */
export interface Transport {
  /**
   * Send a batch of events to the ingester. Returns a `TransportResult`
   * describing per-event acceptance. Throws only for transport-layer
   * failures (network errors, 5xx, timeouts).
   */
  send(events: readonly QueuedEventPayload[], mode: TransportMode): Promise<TransportResult>;
  /** Optional teardown hook. */
  close?(): Promise<void>;
}

/** Retry policy for transient transport failures. */
export interface RetryPolicy {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Multiplier applied per attempt (e.g. 2 -> exponential doubling). */
  readonly backoffMultiplier: number;
  /** Maximum jitter ratio (0..1). Per-attempt jitter ∈ [-jitterRatio, +jitterRatio]. */
  readonly jitterRatio: number;
}

/** Reasons surfaced via `onDrop`. */
export type DropReason =
  | "queue_overflow"
  | "permanent_failure"
  | "retry_exhausted"
  | "validation_failed";

/** Diagnostic kinds surfaced via `onDiagnostic`. */
export type DiagnosticKind =
  | "queue_layer_selected"
  | "queue_pressure"
  | "queue_overflow"
  | "retry"
  | "flush"
  | "validation_failed"
  | "transport_error"
  | "lifecycle_mode_change";

/** Structured diagnostic record. */
export interface Diagnostic {
  readonly kind: DiagnosticKind;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Outcome of a single `flush()` invocation. */
export interface FlushResult {
  /** Events successfully transmitted to the ingester. */
  readonly delivered: number;
  /** Events still queued at the end of the flush. */
  readonly queued: number;
  /** Events dropped during this flush (terminal failures). */
  readonly dropped: number;
  /** Transport mode used for the flush. */
  readonly mode: TransportMode;
}

/**
 * Optional callbacks exposed to applications. None are required. The Web
 * SDK does not emit automatic diagnostic events to Polaris in v1; these
 * are the extension point operators wire into their own logging/metrics.
 */
export interface DiagnosticCallbacks {
  onError?: (error: Error) => void;
  onDrop?: (entry: QueueEntry, reason: DropReason) => void;
  onRetry?: (entry: QueueEntry, attempt: number, error: Error) => void;
  onFlush?: (result: FlushResult) => void;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

/** Options accepted by `track()`. */
export interface TrackOptions {
  /** Optional `context` overrides merged on top of the SDK default context. */
  readonly context?: Partial<Envelope["context"]>;
  /** Producer-supplied occurrence timestamp (ISO 8601 UTC). Defaults to `now`. */
  readonly occurredAt?: Date | string;
  /** Optional `schema_version` for this event. Defaults to `1`. */
  readonly schemaVersion?: number;
  /** Optional consent/privacy metadata to attach to this event. */
  readonly consent?: Envelope["consent"];
  readonly privacy?: Envelope["privacy"];
  /**
   * Local delivery priority. Defaults to `normal`. Affects queue retention
   * under overflow only — priority does NOT change canonical event meaning
   * or vendor routing.
   */
  readonly priority?: EventPriority;
}

/** Source metadata that the SDK stamps on every event. */
export interface WebSourceConfig {
  /** Stable identifier for the producer surface, e.g. `"checkout-app"`. */
  readonly id: string;
  /** Optional SDK version override (auto-detected from the package by default). */
  readonly sdkVersion?: string;
}

/**
 * Web SDK constructor options surface.
 *
 * Endpoint and API key are required at runtime to actually deliver events.
 * Identity manager options are forwarded to the layered identity store.
 */
export interface WebSdkOptions {
  /** Polaris ingestion endpoint, e.g. `https://ingest.polaris.internal/v1/events`. */
  readonly endpoint?: string;
  /** API key bound to project/environment/source by the control plane. */
  readonly apiKey?: string;
  /** Source metadata stamped on every event. */
  readonly source?: WebSourceConfig;
  /** Optional default context merged into every event. */
  readonly defaultContext?: Partial<Envelope["context"]>;
  /** Identity manager options forwarded to the layered identity store. */
  readonly identity?: IdentityManagerOptions;
  /**
   * Maximum number of events held in the queue. Defaults to 1000. Once
   * full, overflow drops by priority (oldest low first, then normal, then
   * high).
   */
  readonly maxQueueSize?: number;
  /**
   * Eager-flush window. For the first `startupEagerFlushWindowMs` after
   * construction the SDK eagerly flushes on every `track()` with a small
   * debounce so quick bursts coalesce into one request. Defaults to
   * 15000ms per the architecture doc.
   */
  readonly startupEagerFlushWindowMs?: number;
  /**
   * Debounce window for the eager-flush phase. Defaults to 100ms.
   */
  readonly startupEagerFlushDebounceMs?: number;
  /**
   * Steady-mode flush interval. After the eager window expires, the SDK
   * flushes at this interval if there are queued events. Defaults to
   * 5000ms.
   */
  readonly steadyFlushIntervalMs?: number;
  /**
   * Maximum batch size per flush. Defaults to 20.
   */
  readonly batchSize?: number;
  /**
   * Retry policy. Defaults to exponential backoff with jitter (max 3
   * retries per the architecture doc).
   */
  readonly retry?: Partial<RetryPolicy>;
  /**
   * Whether to install a `pagehide`/`visibilitychange` listener to flush
   * remaining queue on page exit using `sendBeacon` / `fetch` keepalive.
   * Defaults to `true`. Page-exit delivery is best-effort.
   */
  readonly flushOnPagehide?: boolean;
  /** Optional diagnostic callbacks. */
  readonly diagnostics?: DiagnosticCallbacks;
  /** Inject a custom queue (defaults to layered IndexedDB -> localStorage -> memory). */
  readonly queue?: EventQueue;
  /** Inject a custom transport (defaults to fetch / sendBeacon). */
  readonly transport?: Transport;
  /** Optional clock injection for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Optional ID generator for `event_id`. Defaults to UUIDv7. */
  readonly eventIdGenerator?: () => string;
  /**
   * Inject a `window`/`document` pair for tests in non-DOM contexts. The
   * package is browser-targeted; happy-dom supplies these in tests. If
   * omitted, the SDK reads from `globalThis`.
   */
  readonly window?: Window | undefined;
  readonly document?: Document | undefined;
}
