/**
 * `PolarisNodeSdk` — core SDK class for the Node SDK.
 *
 * Public v1 surface (per `docs/architecture/10-sdk-standards.md`):
 *
 *   - `track(event, properties, options?)`
 *   - `identify(customerId, traits?)`
 *   - `reset(options?)`
 *   - `flush()`
 *   - `close()` (Node-specific lifecycle hook)
 *
 * Behaviour highlights:
 *
 *   - Queue-first: every `track()` assigns a UUIDv7 `event_id` and enqueues
 *     before any transport attempt. `event_id` is preserved across retries.
 *   - Bounded in-memory queue by default (no crash durability). Operators
 *     wanting durable queueing inject a `QueueAdapter` implementation.
 *   - Steady-state interval flush plus batch-size flush plus manual flush.
 *   - Retry with exponential backoff + jitter for transient transport
 *     failures; permanent rejections (per-event reason codes) are surfaced
 *     via `onDrop` and not retried.
 *   - Explicit `flush()` and `close()` lifecycle. No process signal
 *     handlers by default; `autoFlushOnShutdown: true` opts in.
 *   - Diagnostic callbacks (no automatic diagnostic events to Polaris in
 *     v1).
 *
 * Out of scope (will be added in later tasks, NOT here):
 *
 *   - Autocapture, page-view automation, attribution, vendor mappings,
 *     business workflows, schema governance, the full event catalog.
 *   - Durable queue adapters (Redis, filesystem): the interface ships,
 *     adapter implementations are future work.
 */

import type { Envelope } from "@polaris/spec";
import { newEventId, newIdentityId } from "./internal/ids.js";
import { computeBackoffMs, resolveRetryPolicy, sleep } from "./internal/retry.js";
import {
  assertValidCustomerId,
  assertValidEventName,
  assertValidProperties,
  normalizeOccurredAt,
  normalizeSchemaVersion,
} from "./internal/validation.js";
import { SDK_VERSION } from "./internal/version.js";
import { MemoryQueueAdapter } from "./queue/memory.js";
import { HttpsTransport, TransportError } from "./transport/https.js";
import type {
  Diagnostic,
  DiagnosticCallbacks,
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
  TransportResult,
} from "./types.js";

/**
 * Default SDK version stamped into `source.sdk_version` if the caller omits it.
 * Auto-read from the package.json this module is bundled with.
 */
const DEFAULT_SDK_VERSION = SDK_VERSION;

/**
 * Canonical event `identify()` emits. Registered in the catalog with a
 * `.passthrough()` property schema, because traits are project semantics
 * the platform does not enumerate.
 */
const USER_IDENTIFIED_EVENT = "user.identified";

interface PersistentIdentity {
  anonymous_id: string | null;
  session_id: string | null;
  customer_id: string | null;
  device_id: string | null;
}

interface ShutdownSignalHooks {
  readonly signal: NodeJS.Signals;
  readonly handler: () => void;
}

export class PolarisNodeSdk {
  private readonly source: Required<Pick<SourceConfig, "type" | "id">> & {
    readonly sdkVersion: string;
  };
  private readonly defaultContext: Partial<Envelope["context"]>;
  private readonly queue: QueueAdapter;
  private readonly transport: Transport;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly diagnostics: DiagnosticCallbacks;
  private readonly shutdownTimeoutMs: number;
  private readonly identity: PersistentIdentity;
  private readonly intervalTimer: NodeJS.Timeout | undefined;
  private readonly signalHooks: ShutdownSignalHooks[] = [];
  private readonly inFlight: Set<QueuedEvent> = new Set();
  private flushChain: Promise<FlushResult> = Promise.resolve({
    delivered: 0,
    queued: 0,
    dropped: 0,
  });
  private closed = false;

  public constructor(options: PolarisSdkOptions) {
    if (!options.endpoint) throw new Error("PolarisNodeSdk: endpoint is required");
    if (!options.apiKey) throw new Error("PolarisNodeSdk: apiKey is required");
    if (!options.source?.id) throw new Error("PolarisNodeSdk: source.id is required");
    if (!options.source.type) throw new Error("PolarisNodeSdk: source.type is required");

    const maxQueueSize = options.maxQueueSize ?? 10_000;
    if (!Number.isInteger(maxQueueSize) || maxQueueSize <= 0) {
      throw new Error("PolarisNodeSdk: maxQueueSize must be a positive integer");
    }
    const batchSize = options.batchSize ?? 50;
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error("PolarisNodeSdk: batchSize must be a positive integer");
    }
    const flushIntervalMs = options.flushIntervalMs ?? 5_000;
    if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 0) {
      throw new Error("PolarisNodeSdk: flushIntervalMs must be >= 0");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("PolarisNodeSdk: requestTimeoutMs must be > 0");
    }
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 0) {
      throw new Error("PolarisNodeSdk: shutdownTimeoutMs must be >= 0");
    }

    this.source = {
      type: options.source.type,
      id: options.source.id,
      sdkVersion: options.source.sdkVersion ?? DEFAULT_SDK_VERSION,
    };
    this.defaultContext = options.defaultContext ?? {};
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.retryPolicy = resolveRetryPolicy(options.retry);
    this.diagnostics = options.diagnostics ?? {};

    this.identity = {
      anonymous_id: options.identity?.anonymous_id ?? newIdentityId("anon"),
      session_id: options.identity?.session_id ?? newIdentityId("sess"),
      customer_id: options.identity?.customer_id ?? null,
      device_id: options.identity?.device_id ?? null,
    };

    this.queue = options.queue ?? new MemoryQueueAdapter({ maxSize: maxQueueSize });
    this.transport =
      options.transport ??
      new HttpsTransport({
        endpoint: options.endpoint,
        apiKey: options.apiKey,
        userAgent: `polaris-node-sdk/${this.source.sdkVersion}`,
        requestTimeoutMs,
      });

    if (this.flushIntervalMs > 0) {
      const timer = setInterval(() => {
        // Best-effort background flush. Errors flow through `onError`.
        this.flush().catch((err: unknown) => {
          this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
        });
      }, this.flushIntervalMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }
      this.intervalTimer = timer;
    }

    if (options.autoFlushOnShutdown === true) {
      this.registerShutdownHandlers();
    }
  }

  /**
   * Snapshot of the SDK's current identity state.
   *
   * Returned as a frozen copy so callers can attach `anonymous_id` /
   * `session_id` / `customer_id` / `device_id` to their own application
   * log lines, propagate them into trace contexts, or correlate Polaris
   * events with other systems — without firing a Polaris event just to
   * inspect the values. This is an identity helper, not a state store:
   * read-only on a single SDK instance, never aggregated across users.
   */
  public getIdentity(): Readonly<PersistentIdentity> {
    return Object.freeze({ ...this.identity });
  }

  public async track(
    event: string,
    properties?: Record<string, unknown>,
    options?: TrackOptions,
  ): Promise<string> {
    this.assertOpen();
    assertValidEventName(event);
    assertValidProperties(properties);
    const occurredAt = normalizeOccurredAt(options?.occurredAt);
    const schemaVersion = normalizeSchemaVersion(options?.schemaVersion);

    const eventId = newEventId();
    const queued: QueuedEvent = {
      event_id: eventId,
      event,
      schema_version: schemaVersion,
      occurred_at: occurredAt,
      source: {
        type: this.source.type,
        id: this.source.id,
        sdk: "node",
        sdk_version: this.source.sdkVersion,
      },
      identity: this.mergeIdentity(options?.identity),
      context: this.mergeContext(options?.context),
      properties: Object.freeze({ ...(properties ?? {}) }),
      ...(options?.consent !== undefined ? { consent: options.consent } : {}),
      ...(options?.privacy !== undefined ? { privacy: options.privacy } : {}),
    };

    const accepted = await Promise.resolve(this.queue.enqueue(queued));
    if (!accepted) {
      this.handleDrop(queued, "queue_overflow");
      this.emitDiagnostic({
        kind: "queue_overflow",
        message: "queue overflow; event dropped",
        detail: { event_id: queued.event_id, event: queued.event },
      });
      return eventId;
    }

    // Eager-flush when the queue passes the batch threshold. We do not
    // await it — track() returns once the event is durably enqueued. The
    // diagnostic onFlush callback is the right place to observe outcomes.
    const size = await Promise.resolve(this.queue.size());
    if (size >= this.batchSize) {
      this.flush().catch((err: unknown) => {
        this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
      });
    }
    return eventId;
  }

  /**
   * Associate a `customer_id` with subsequent events AND emit
   * `user.identified` carrying the traits.
   *
   * v1 accepted `traits` and discarded them because no authoritative
   * event existed in the catalog to carry them; this comment deferred to
   * "future versions may emit an identify event when an authoritative
   * event exists". It does now — `user.identified` v1 is registered, and
   * the identity stage merge-patches its properties into the profile
   * store. This remains a transport helper, not an analytics engine: the
   * SDK enqueues one canonical event and interprets nothing.
   *
   * Ordering is load-bearing. The customer id is set BEFORE the event is
   * built, so the envelope carries `anonymous_id` AND `customer_id`
   * together. That co-occurrence is precisely what lets the resolver bind
   * both identifiers to one profile; emitting first would leave the
   * anonymous history unlinked.
   *
   * Fire-and-forget, so `identify()` keeps its synchronous, non-throwing
   * contract. Enqueue failures reach the configured error handler exactly
   * like any other dropped event.
   */
  public identify(customerId: string, traits?: IdentifyTraits): void {
    this.assertOpen();
    assertValidCustomerId(customerId);
    this.identity.customer_id = customerId;

    void this.track(USER_IDENTIFIED_EVENT, { ...(traits ?? {}) }).catch((err: unknown) => {
      this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /**
   * Clear customer identity, rotate session, and (by default) rotate
   * anonymous identity. Mirrors the Web SDK behaviour described in
   * `10-sdk-standards.md`.
   */
  public reset(options?: ResetOptions): void {
    this.assertOpen();
    const rotateAnonymous = options?.anonymous !== false;
    this.identity.customer_id = null;
    this.identity.session_id = newIdentityId("sess");
    if (rotateAnonymous) {
      this.identity.anonymous_id = newIdentityId("anon");
    }
  }

  /**
   * Drain the queue once and attempt to deliver. Concurrent `flush()`
   * calls are serialized — the second call waits for the first to
   * complete and observes only its own slice of work (it may end up
   * delivering 0 events if the first call drained the queue).
   */
  public flush(): Promise<FlushResult> {
    const previous = this.flushChain;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const result = await this.drainAndDeliver();
        this.emitOnFlush(result);
        return result;
      });
    this.flushChain = next;
    return next;
  }

  /**
   * Stop accepting new events, flush remaining queue with timeout, then
   * release transport resources. Idempotent.
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.intervalTimer !== undefined) {
      clearInterval(this.intervalTimer);
    }

    const flushPromise = this.drainUntilEmpty();
    const timeoutPromise = sleep(this.shutdownTimeoutMs).then(() => "timeout" as const);
    const winner = await Promise.race([
      flushPromise.then(() => "drained" as const),
      timeoutPromise,
    ]);
    if (winner === "timeout") {
      // Drop everything still queued AND everything in-flight that the
      // transport never resolved. Callers asked for a bounded shutdown;
      // an unbounded retry loop here would block process exit.
      const remainingQueued = await Promise.resolve(this.queue.drain(Number.MAX_SAFE_INTEGER));
      for (const event of remainingQueued) {
        this.handleDrop(event, "shutdown_timeout");
      }
      const remainingInFlight = Array.from(this.inFlight);
      this.inFlight.clear();
      for (const event of remainingInFlight) {
        this.handleDrop(event, "shutdown_timeout");
      }
      this.emitDiagnostic({
        kind: "shutdown_timeout",
        message: "shutdown drain timed out; remaining events dropped",
        detail: {
          dropped: remainingQueued.length + remainingInFlight.length,
        },
      });
    }

    if (this.queue.close !== undefined) {
      await Promise.resolve(this.queue.close());
    }
    if (this.transport.close !== undefined) {
      await Promise.resolve(this.transport.close());
    }

    for (const hook of this.signalHooks) {
      process.off(hook.signal, hook.handler);
    }
    this.signalHooks.length = 0;
  }

  // --- internal ---------------------------------------------------------

  private mergeIdentity(overrides: IdentityOverrides | undefined): Envelope["identity"] {
    if (!overrides) return { ...this.identity };
    return {
      anonymous_id: overrides.anonymous_id ?? this.identity.anonymous_id,
      session_id: overrides.session_id ?? this.identity.session_id,
      customer_id: overrides.customer_id ?? this.identity.customer_id,
      device_id: overrides.device_id ?? this.identity.device_id,
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

  private async drainAndDeliver(): Promise<FlushResult> {
    const events = await Promise.resolve(this.queue.drain(this.batchSize));
    if (events.length === 0) {
      return { delivered: 0, queued: 0, dropped: 0 };
    }

    // Track in-flight events so a shutdown timeout can drop them with the
    // right reason if the transport hangs forever.
    for (const event of events) this.inFlight.add(event);

    let attempt = 0;
    let delivered = 0;
    let dropped = 0;
    let remaining: QueuedEvent[] = [...events];

    try {
      while (remaining.length > 0 && attempt < this.retryPolicy.maxAttempts) {
        attempt += 1;
        let result: TransportResult;
        try {
          result = await this.transport.send(remaining);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const retryable =
            error instanceof TransportError ? error.retryable : true; /* unknown → retryable */
          for (const event of remaining) {
            this.invokeOnRetry(event, attempt, error);
          }
          this.emitDiagnostic({
            kind: "retry",
            message: `transport error on attempt ${attempt}: ${error.message}`,
            detail: { attempt, retryable },
          });
          if (!retryable || attempt >= this.retryPolicy.maxAttempts) {
            for (const event of remaining) {
              this.handleDrop(event, "permanent_failure");
              this.inFlight.delete(event);
            }
            dropped += remaining.length;
            this.invokeOnError(error);
            remaining = [];
            break;
          }
          await sleep(computeBackoffMs(this.retryPolicy, attempt));
          continue;
        }

        // Partition rejected events into retryable vs permanent.
        const acceptedIds = new Set(result.accepted.map((entry) => entry.event_id));
        const retryableIds = new Set<string>();
        for (const entry of result.rejected) {
          if (entry.retryable === true) {
            retryableIds.add(entry.event_id);
          } else {
            // Drop with the reason returned by the ingester.
            const droppedEvent = remaining.find((e) => e.event_id === entry.event_id);
            if (droppedEvent !== undefined) {
              this.handleDrop(droppedEvent, "permanent_failure");
              this.inFlight.delete(droppedEvent);
              dropped += 1;
            }
          }
        }

        for (const e of remaining) {
          if (acceptedIds.has(e.event_id)) {
            this.inFlight.delete(e);
            delivered += 1;
          }
        }
        const stillPending = remaining.filter((e) => retryableIds.has(e.event_id));
        if (stillPending.length === 0) {
          remaining = [];
          break;
        }
        remaining = stillPending;
        if (attempt < this.retryPolicy.maxAttempts) {
          await sleep(computeBackoffMs(this.retryPolicy, attempt));
        }
      }

      // Anything left after exhausting attempts goes back to the queue so
      // the next flush (or a `close()`-driven drain) can retry. event_id is
      // preserved across this round trip.
      if (remaining.length > 0) {
        await Promise.resolve(this.queue.requeue(remaining));
        for (const e of remaining) this.inFlight.delete(e);
      }
    } finally {
      // Defensive cleanup: any path that throws an unexpected error
      // should not leak in-flight references. The shutdown path drops
      // anything still tracked here.
      for (const e of events) this.inFlight.delete(e);
    }

    const queued = await Promise.resolve(this.queue.size());
    return { delivered, queued, dropped };
  }

  private async drainUntilEmpty(): Promise<void> {
    // Drain repeatedly until the queue is empty or `close()` decides to
    // give up. Each iteration goes through the same delivery + retry path
    // as a normal flush.
    while (true) {
      const size = await Promise.resolve(this.queue.size());
      if (size === 0) return;
      const result = await this.drainAndDeliver();
      this.emitOnFlush(result);
      // If we made no forward progress (still queued, nothing delivered or
      // dropped), bail out so we don't tight-loop.
      if (result.delivered === 0 && result.dropped === 0 && result.queued > 0) {
        return;
      }
    }
  }

  private registerShutdownHandlers(): void {
    const handler = (): void => {
      this.close().catch((err: unknown) => {
        this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
      });
    };
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
    for (const signal of signals) {
      process.once(signal, handler);
      this.signalHooks.push({ signal, handler });
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("PolarisNodeSdk: cannot use SDK after close()");
    }
  }

  private handleDrop(event: QueuedEvent, reason: DropReason): void {
    try {
      this.diagnostics.onDrop?.(event, reason);
    } catch (err) {
      this.invokeOnError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private invokeOnRetry(event: QueuedEvent, attempt: number, error: Error): void {
    try {
      this.diagnostics.onRetry?.(event, attempt, error);
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
