/**
 * `PolarisWebSdk` — the public class for `@polaris/web-sdk`.
 *
 * P3-002 shipped the identity-persistence layer; P3-003 adds:
 *
 *   - layered event queue (IndexedDB -> localStorage -> memory)
 *   - HTTPS transport (fetch / sendBeacon)
 *   - retry coordinator with exponential backoff + jitter
 *   - lifecycle controller (eager-flush window, steady mode, pagehide)
 *   - real `track()` and `flush()` semantics on top of the identity
 *     manager built in P3-002.
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
 *   - Queue order: IndexedDB preferred -> localStorage fallback ->
 *     memory fallback. Cookies are NEVER used for event queues.
 *   - 0-15s after construction: eager flush mode with a 100ms debounce.
 *   - After 15s: steady batch mode (default 5s interval, batch size 20).
 *   - pagehide / `visibilitychange` triggers an urgent flush via
 *     `sendBeacon` (with `fetch` keepalive fallback). Page-exit
 *     delivery is best-effort.
 *   - Overflow drops by priority (oldest low -> oldest normal ->
 *     oldest high). `track()` does NOT throw on overflow.
 *   - `event_id` is preserved across retries.
 *   - Retry policy: exponential backoff with jitter, max 3 retries.
 *   - Diagnostics are callback-only. The SDK does NOT emit automatic
 *     diagnostic events to Polaris in v1.
 *
 * Construction is async because IndexedDB probing is asynchronous. Use
 * `PolarisWebSdk.create(options)` for the recommended path:
 *
 *   ```ts
 *   const sdk = await PolarisWebSdk.create({
 *     endpoint: "https://ingest.polaris.internal/v1/events",
 *     apiKey: process.env.POLARIS_API_KEY!,
 *     source: { id: "checkout-app" },
 *   });
 *   await sdk.track("page.viewed", { path: location.pathname });
 *   ```
 *
 * `new PolarisWebSdk()` is still supported for callers passing a custom
 * queue (the queue's own creation is then their concern). The
 * synchronous default in that path is the always-available memory queue.
 */

import type { Envelope } from "@polaris/spec";
import { IdentityManager } from "./identity/manager.js";
import { newEventId as defaultEventId } from "./internal/ids.js";
import { type FlushCallback, LifecycleController } from "./internal/lifecycle.js";
import { computeBackoffMs, resolveRetryPolicy, sleep } from "./internal/retry.js";
import {
  assertValidEventName,
  assertValidProperties,
  normalizeOccurredAt,
  normalizePriority,
  normalizeSchemaVersion,
} from "./internal/validation.js";
import { SDK_VERSION } from "./internal/version.js";
import { LayeredEventQueue } from "./queue/layered-queue.js";
import { MemoryQueue } from "./queue/memory-queue.js";
import { HttpsTransport, TransportError } from "./transport/https.js";
import type {
  Diagnostic,
  DiagnosticCallbacks,
  DropReason,
  EnqueueOutcome,
  EnvelopeIdentity,
  EventPriority,
  EventQueue,
  FlushResult,
  IdentifyTraits,
  IdentityCapability,
  IdentityDiagnostics,
  QueuedEventPayload,
  QueueEntry,
  ResetOptions,
  RetryPolicy,
  TrackOptions,
  Transport,
  TransportMode,
  TransportResult,
  WebSdkOptions,
} from "./types.js";

/**
 * Canonical event `identify()` emits. Registered in the catalog with a
 * `.passthrough()` property schema, because traits are project semantics
 * the platform does not enumerate.
 */
const USER_IDENTIFIED_EVENT = "user.identified";

const DEFAULT_MAX_QUEUE_SIZE = 1_000;
const DEFAULT_EAGER_WINDOW_MS = 15_000;
const DEFAULT_EAGER_DEBOUNCE_MS = 100;
const DEFAULT_STEADY_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_SOURCE_ID = "web";

export class PolarisWebSdk {
  private readonly identityManager: IdentityManager;
  private readonly queue: EventQueue;
  private readonly transport: Transport | undefined;
  private readonly diagnostics: DiagnosticCallbacks;
  private readonly retryPolicy: RetryPolicy;
  private readonly batchSize: number;
  private readonly defaultContext: Partial<Envelope["context"]>;
  private readonly source: {
    readonly type: "browser";
    readonly id: string;
    readonly sdk: "web";
    readonly sdk_version: string;
  };
  private readonly lifecycle: LifecycleController | undefined;
  private readonly eventIdGenerator: () => string;
  private readonly clock: () => number;

  private flushChain: Promise<FlushResult> = Promise.resolve({
    delivered: 0,
    queued: 0,
    dropped: 0,
    mode: "steady" as TransportMode,
  });
  private closed = false;

  /**
   * Recommended constructor. Probes IndexedDB asynchronously, then
   * resolves with a fully-wired SDK.
   */
  public static async create(options: WebSdkOptions = {}): Promise<PolarisWebSdk> {
    const queue =
      options.queue ??
      (await LayeredEventQueue.create({
        maxSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
        indexedDB: resolveIndexedDb(options.window),
        localStorage: resolveLocalStorage(options.window),
      }));
    return new PolarisWebSdk({ ...options, queue });
  }

  public constructor(options: WebSdkOptions = {}) {
    this.identityManager = new IdentityManager(options.identity);
    this.diagnostics = options.diagnostics ?? {};
    this.retryPolicy = resolveRetryPolicy(options.retry);
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.defaultContext = options.defaultContext ?? {};
    this.eventIdGenerator = options.eventIdGenerator ?? defaultEventId;
    this.clock = options.now ?? (() => Date.now());
    this.source = {
      type: "browser",
      id: options.source?.id ?? DEFAULT_SOURCE_ID,
      sdk: "web",
      sdk_version: options.source?.sdkVersion ?? SDK_VERSION,
    };

    if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
      throw new Error("PolarisWebSdk: batchSize must be a positive integer");
    }

    // Queue: explicit option wins; otherwise synchronous default to the
    // always-available memory queue. Callers that want the full layered
    // queue should use `PolarisWebSdk.create()` (async).
    this.queue =
      options.queue ?? new MemoryQueue({ maxSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE });

    // Transport is optional when the caller is testing the queue layer
    // in isolation. flush() returns the empty result in that case.
    if (options.transport !== undefined) {
      this.transport = options.transport;
    } else if (options.endpoint !== undefined && options.apiKey !== undefined) {
      this.transport = new HttpsTransport({
        endpoint: options.endpoint,
        apiKey: options.apiKey,
        userAgent: `polaris-web-sdk/${this.source.sdk_version}`,
      });
    } else {
      this.transport = undefined;
    }

    const eagerWindowMs = options.startupEagerFlushWindowMs ?? DEFAULT_EAGER_WINDOW_MS;
    const eagerDebounceMs = options.startupEagerFlushDebounceMs ?? DEFAULT_EAGER_DEBOUNCE_MS;
    const steadyIntervalMs = options.steadyFlushIntervalMs ?? DEFAULT_STEADY_INTERVAL_MS;
    const flushOnPagehide = options.flushOnPagehide ?? true;

    // The lifecycle controller is skipped only when steadyIntervalMs AND
    // eagerWindowMs are both 0 AND flushOnPagehide is false — that's the
    // "tests drive flush() manually" configuration.
    if (eagerWindowMs === 0 && steadyIntervalMs === 0 && !flushOnPagehide) {
      this.lifecycle = undefined;
    } else {
      this.lifecycle = new LifecycleController({
        eagerWindowMs,
        eagerDebounceMs,
        steadyIntervalMs,
        flushOnPagehide,
        window: options.window ?? resolveDefaultWindow(),
        document: options.document ?? resolveDefaultDocument(),
        now: this.clock,
      });
      const flushCallback: FlushCallback = (mode) => this.flushInternal(mode);
      this.lifecycle.start(flushCallback);
    }

    this.emitDiagnostic({
      kind: "queue_layer_selected",
      message: `queue layer = ${this.queue.layer}`,
      detail: { layer: this.queue.layer },
    });
  }

  // ---- identity surface (forwarded from P3-002) -----------------------

  /** Identity manager for callers that want direct access to the layered store. */
  public getIdentityManager(): IdentityManager {
    return this.identityManager;
  }

  /** Capability detection snapshot. */
  public getCapability(): IdentityCapability {
    return this.identityManager.getCapability();
  }

  /** Diagnostic snapshot (storage layer, capability, last activity timestamp). */
  public getDiagnostics(): IdentityDiagnostics {
    return this.identityManager.getDiagnostics();
  }

  /** Envelope-shaped identity for the transport layer. */
  public getEnvelopeIdentity(): EnvelopeIdentity {
    return this.identityManager.toEnvelopeIdentity();
  }

  /**
   * Associate a `customer_id` with subsequent events AND emit
   * `user.identified` carrying the traits.
   *
   * The identity manager still owns local persistence (cookie →
   * localStorage → sessionStorage → memory), unchanged. What is new is
   * that traits no longer stop there: `user.identified` v1 is registered
   * in the catalog and the identity stage merge-patches its properties
   * into the profile store. Before that event existed, the manager
   * accepted `traits` and dropped them, because there was nowhere for
   * them to go.
   *
   * Ordering is load-bearing. Identity is set BEFORE the event is built,
   * so the envelope carries `anonymous_id` and `customer_id` together —
   * the co-occurrence the resolver binds into one profile. Emitting first
   * would leave the anonymous history unlinked.
   *
   * Fire-and-forget, so `identify()` keeps its synchronous, non-throwing
   * contract. A queue failure surfaces through `onError` like any other
   * dropped event.
   */
  public identify(customerId: string, traits?: IdentifyTraits): void {
    this.identityManager.identify(customerId, traits);

    void this.track(USER_IDENTIFIED_EVENT, { ...(traits ?? {}) }).catch((err: unknown) => {
      this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /** Clear customer identity, rotate session, and (by default) rotate anonymous. */
  public reset(options?: ResetOptions): void {
    this.identityManager.reset(options);
  }

  // ---- core surface (P3-003) ------------------------------------------

  /**
   * Track an event. Returns once the event is durably enqueued (or the
   * in-memory queue accepts it). Retries happen out of band.
   *
   * Per the architecture doc:
   *   - `track()` does NOT throw on queue overflow.
   *   - `event_id` is generated SDK-side as UUIDv7.
   *   - Identity is stamped from the `IdentityManager` (P3-002).
   *   - Priority defaults to `normal`.
   */
  public async track(
    event: string,
    properties?: Record<string, unknown>,
    options?: TrackOptions,
  ): Promise<string> {
    if (this.closed) {
      throw new Error("PolarisWebSdk: cannot use SDK after close()");
    }
    assertValidEventName(event);
    assertValidProperties(properties);
    const occurredAt = normalizeOccurredAt(options?.occurredAt);
    const schemaVersion = normalizeSchemaVersion(options?.schemaVersion);
    const priority = normalizePriority(options?.priority);

    const eventId = this.eventIdGenerator();
    const payload: QueuedEventPayload = {
      event_id: eventId,
      event,
      schema_version: schemaVersion,
      occurred_at: occurredAt,
      source: this.source,
      identity: this.identityManager.toEnvelopeIdentity(),
      context: this.mergeContext(options?.context),
      properties: Object.freeze({ ...(properties ?? {}) }),
      ...(options?.consent !== undefined ? { consent: options.consent } : {}),
      ...(options?.privacy !== undefined ? { privacy: options.privacy } : {}),
    };
    const entry: QueueEntry = {
      payload,
      priority,
      attempts: 0,
      enqueued_at: this.clock(),
    };

    let outcome: EnqueueOutcome;
    try {
      outcome = await this.queue.enqueue(entry);
    } catch (err) {
      this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
      // Treat enqueue failure as a drop — the SDK does NOT throw on
      // queue-level errors per the architecture doc.
      this.handleDrop(entry, "queue_overflow");
      return eventId;
    }

    if (outcome.status === "rejected") {
      this.handleDrop(entry, "queue_overflow");
      this.emitDiagnostic({
        kind: "queue_overflow",
        message: "queue overflow; event dropped",
        detail: { event_id: eventId, event, priority },
      });
    } else if (outcome.status === "accepted_with_drops") {
      for (const dropped of outcome.dropped) {
        this.handleDrop(dropped, "queue_overflow");
      }
      this.emitDiagnostic({
        kind: "queue_overflow",
        message: "queue overflow; older lower-priority events evicted",
        detail: {
          event_id: eventId,
          evicted: outcome.dropped.length,
        },
      });
    }

    // Notify the lifecycle controller — it'll start the eager-flush
    // debounce in eager mode, or no-op in steady mode (the interval
    // handles steady).
    this.lifecycle?.notifyEnqueue();

    // Batch-size trigger: if the queue is at-or-above the batch threshold,
    // kick off a flush right away. This complements the eager debounce so
    // a fast burst delivers without waiting on the interval.
    const size = await this.queue.size();
    if (size >= this.batchSize) {
      // Fire-and-forget — track() returns once the event is durably
      // enqueued. Errors are surfaced via diagnostic callbacks.
      this.flushInternal("steady").catch((err: unknown) => {
        this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
      });
    }

    return eventId;
  }

  /**
   * Drain the queue once and attempt to deliver. Concurrent `flush()`
   * calls are serialized — the second call waits for the first to
   * complete and observes only its own slice of work (it may end up
   * delivering 0 events if the first call drained the queue).
   */
  public flush(): Promise<FlushResult> {
    return this.flushInternal("steady");
  }

  /**
   * Stop accepting new events, drain the queue once (best-effort), and
   * release transport resources. Idempotent.
   *
   * The Web SDK does NOT block on a full drain at close time — the doc
   * is explicit that page-exit delivery is best-effort. Callers wanting
   * stronger guarantees in a SPA's logout flow should call `flush()`
   * explicitly before `close()`.
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.lifecycle !== undefined) {
      this.lifecycle.close();
    }
    try {
      await this.flushInternal("urgent");
    } catch {
      // Best-effort flush.
    }
    if (this.queue.close !== undefined) {
      try {
        await this.queue.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    if (this.transport?.close !== undefined) {
      try {
        await this.transport.close();
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  // ---- internal --------------------------------------------------------

  private flushInternal(mode: TransportMode): Promise<FlushResult> {
    const previous = this.flushChain;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const result = await this.drainAndDeliver(mode);
        this.emitOnFlush(result);
        return result;
      });
    this.flushChain = next;
    return next;
  }

  private async drainAndDeliver(mode: TransportMode): Promise<FlushResult> {
    if (this.transport === undefined) {
      return { delivered: 0, queued: await this.queue.size(), dropped: 0, mode };
    }
    const entries =
      mode === "urgent" ? await this.queue.drainAll() : await this.queue.drain(this.batchSize);
    if (entries.length === 0) {
      return { delivered: 0, queued: 0, dropped: 0, mode };
    }

    let attempt = 0;
    let delivered = 0;
    let dropped = 0;
    let remaining: QueueEntry[] = [...entries];
    const totalAttempts = this.retryPolicy.maxRetries + 1;

    while (remaining.length > 0 && attempt < totalAttempts) {
      attempt += 1;
      // Stamp attempts on each entry (preserved for retry diagnostics).
      remaining = remaining.map((e) => ({ ...e, attempts: e.attempts + 1 }));
      const payloads = remaining.map((e) => e.payload);
      let result: TransportResult;
      try {
        result = await this.transport.send(payloads, mode);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const retryable = error instanceof TransportError ? error.retryable : true;
        for (const entry of remaining) {
          this.invokeOnRetry(entry, attempt, error);
        }
        this.emitDiagnostic({
          kind: "retry",
          message: `transport error on attempt ${attempt}: ${error.message}`,
          detail: { attempt, retryable },
        });
        if (mode === "urgent") {
          // Urgent flushes don't retry — the tab is racing the unload.
          // Re-queue what we drained so the next session can retry.
          await this.queue.requeue(remaining);
          this.invokeOnError(error);
          return {
            delivered,
            queued: await this.queue.size(),
            dropped,
            mode,
          };
        }
        if (!retryable || attempt >= totalAttempts) {
          for (const entry of remaining) {
            this.handleDrop(entry, "permanent_failure");
            dropped += 1;
          }
          this.invokeOnError(error);
          remaining = [];
          break;
        }
        await sleep(computeBackoffMs(this.retryPolicy, attempt));
        continue;
      }

      // Partition rejected entries into retryable vs permanent.
      const acceptedIds = new Set(result.accepted.map((entry) => entry.event_id));
      const retryableIds = new Set<string>();
      for (const entry of result.rejected) {
        if (entry.retryable === true) {
          retryableIds.add(entry.event_id);
        } else {
          const droppedEntry = remaining.find((e) => e.payload.event_id === entry.event_id);
          if (droppedEntry !== undefined) {
            this.handleDrop(droppedEntry, "permanent_failure");
            dropped += 1;
          }
        }
      }

      for (const entry of remaining) {
        if (acceptedIds.has(entry.payload.event_id)) {
          delivered += 1;
        }
      }
      const stillPending = remaining.filter((e) => retryableIds.has(e.payload.event_id));
      if (stillPending.length === 0) {
        remaining = [];
        break;
      }
      remaining = stillPending;
      if (mode === "urgent") {
        // Urgent never retries in-line.
        break;
      }
      if (attempt < totalAttempts) {
        await sleep(computeBackoffMs(this.retryPolicy, attempt));
      }
    }

    // Anything left after exhausting attempts goes back to the queue so
    // the next flush can retry. event_id is preserved across this round
    // trip — the entries are the same objects we drained, only `attempts`
    // moved forward.
    if (remaining.length > 0) {
      await this.queue.requeue(remaining);
    }

    return {
      delivered,
      queued: await this.queue.size(),
      dropped,
      mode,
    };
  }

  private mergeContext(overrides: Partial<Envelope["context"]> | undefined): Envelope["context"] {
    const base: Envelope["context"] = {
      ip: this.defaultContext.ip ?? null,
      user_agent: this.defaultContext.user_agent ?? null,
      locale: this.defaultContext.locale ?? null,
      page: this.defaultContext.page ?? null,
      campaign: this.defaultContext.campaign ?? null,
    };
    if (!overrides) return base;
    return {
      ip: overrides.ip ?? base.ip,
      user_agent: overrides.user_agent ?? base.user_agent,
      locale: overrides.locale ?? base.locale,
      page: overrides.page !== undefined ? overrides.page : base.page,
      campaign: overrides.campaign !== undefined ? overrides.campaign : base.campaign,
    };
  }

  // ---- diagnostic plumbing -------------------------------------------

  private handleDrop(entry: QueueEntry, reason: DropReason): void {
    try {
      this.diagnostics.onDrop?.(entry, reason);
    } catch (err) {
      this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private invokeOnRetry(entry: QueueEntry, attempt: number, error: Error): void {
    try {
      this.diagnostics.onRetry?.(entry, attempt, error);
    } catch (err) {
      this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private invokeOnError(error: Error): void {
    const handler = this.diagnostics.onError;
    if (handler === undefined) return;
    try {
      handler(error);
    } catch {
      // Swallow: producer-supplied callbacks must not bring down the SDK.
    }
  }

  private emitOnFlush(result: FlushResult): void {
    try {
      this.diagnostics.onFlush?.(result);
    } catch (err) {
      this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private emitDiagnostic(diagnostic: Diagnostic): void {
    try {
      this.diagnostics.onDiagnostic?.(diagnostic);
    } catch (err) {
      this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ---- helpers --------------------------------------------------------

function resolveDefaultWindow(): Window | undefined {
  const maybe = (globalThis as { window?: Window }).window;
  return maybe;
}

function resolveDefaultDocument(): Document | undefined {
  const maybe = (globalThis as { document?: Document }).document;
  return maybe;
}

function resolveIndexedDb(win: Window | undefined): IDBFactory | undefined {
  const target = win ?? resolveDefaultWindow();
  if (target === undefined) return undefined;
  try {
    const maybe = (target as Window & { indexedDB?: IDBFactory }).indexedDB;
    return maybe ?? undefined;
  } catch {
    return undefined;
  }
}

function resolveLocalStorage(win: Window | undefined): Storage | undefined {
  const target = win ?? resolveDefaultWindow();
  if (target === undefined) return undefined;
  try {
    return target.localStorage;
  } catch {
    return undefined;
  }
}

/** Re-export the priority type alias here for ergonomic imports. */
export type { EventPriority };
