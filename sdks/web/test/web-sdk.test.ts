// @vitest-environment happy-dom
/**
 * `PolarisWebSdk` — end-to-end track + flush + retry + lifecycle tests.
 *
 * Covers the P3-003 contract from `docs/architecture/10-sdk-standards.md`:
 *
 *   - track() returns once the event is enqueued; retries happen out of
 *     band
 *   - event_id is preserved across retries
 *   - permanent rejections drop; retryable rejections requeue
 *   - priority overflow drops oldest low, then normal, then high
 *   - eager flush window coalesces a track() burst into one request
 *   - steady-mode interval fires the next flush automatically
 *   - pagehide triggers an urgent flush via sendBeacon
 *   - identity (anonymous_id, session_id, customer_id) is stamped on
 *     every event from the IdentityManager
 *
 * Tests inject a fake transport so we don't hit a real network. Lifecycle
 * timing is mostly driven by injected timers via the lifecycle tests; the
 * SDK-level tests rely on the default real timers being short (eager
 * debounce 100ms, steady 5s) — we disable the lifecycle controller in
 * most tests by setting eager/steady to 0 and pagehide to false, then
 * drive flush() manually.
 */

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PolarisWebSdk } from "../src/sdk.js";
import { TransportError } from "../src/transport/https.js";
import type {
  QueuedEventPayload,
  Transport,
  TransportMode,
  TransportResult,
  WebSdkOptions,
} from "../src/types.js";
import { clearAllCookies } from "./helpers/dom.js";

/** Fake transport recording sends and replaying canned results. */
class FakeTransport implements Transport {
  public readonly sends: Array<{
    readonly mode: TransportMode;
    readonly events: readonly QueuedEventPayload[];
  }> = [];
  public closed = false;
  private readonly behaviour: (
    attempt: number,
    events: readonly QueuedEventPayload[],
    mode: TransportMode,
  ) => Promise<TransportResult>;

  public constructor(
    behaviour: (
      attempt: number,
      events: readonly QueuedEventPayload[],
      mode: TransportMode,
    ) => Promise<TransportResult>,
  ) {
    this.behaviour = behaviour;
  }

  public async send(
    events: readonly QueuedEventPayload[],
    mode: TransportMode,
  ): Promise<TransportResult> {
    this.sends.push({ mode, events: [...events] });
    return this.behaviour(this.sends.length, events, mode);
  }

  public close(): void {
    this.closed = true;
  }
}

function acceptAll(events: readonly QueuedEventPayload[]): TransportResult {
  return {
    accepted: events.map((e) => ({ event_id: e.event_id, status: "accepted" as const })),
    rejected: [],
  };
}

function baseOptions(overrides: Partial<WebSdkOptions> = {}): WebSdkOptions {
  return {
    endpoint: "https://example.invalid/events",
    apiKey: "test-key",
    source: { id: "test-app", sdkVersion: "0.0.0-test" },
    // Disable lifecycle timers in unit tests so we can drive flush() manually.
    startupEagerFlushWindowMs: 0,
    startupEagerFlushDebounceMs: 100,
    steadyFlushIntervalMs: 0,
    flushOnPagehide: false,
    batchSize: 20,
    retry: {
      maxRetries: 3,
      initialDelayMs: 1,
      maxDelayMs: 5,
      backoffMultiplier: 2,
      jitterRatio: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearAllCookies();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  clearAllCookies();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// ---- track + flush happy path ----------------------------------------

describe("PolarisWebSdk.track (queue-first)", () => {
  it("enqueues before any transport call (no eager flush below batchSize)", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisWebSdk(baseOptions({ transport, batchSize: 10 }));
    await sdk.track("page.viewed", { amount: 1 });
    await sdk.track("page.viewed", { amount: 2 });
    expect(transport.sends.length).toBe(0);
    const flush = await sdk.flush();
    expect(flush.delivered).toBe(2);
    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0]?.events.length).toBe(2);
  });

  it("returns a UUIDv7-shaped event_id", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisWebSdk(baseOptions({ transport }));
    const id = await sdk.track("page.viewed", {});
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("rejects invalid event names without enqueueing", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisWebSdk(baseOptions({ transport }));
    await expect(sdk.track("bad name", {})).rejects.toThrowError();
    await sdk.flush();
    expect(transport.sends.length).toBe(0);
  });

  it("stamps source, identity, and context on every event", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisWebSdk(
      baseOptions({
        transport,
        defaultContext: { locale: "pt-BR" },
      }),
    );
    await sdk.track("page.viewed", { x: 1 }, { context: { ip: "203.0.113.10" } });
    await sdk.flush();
    const sent = transport.sends[0]?.events[0];
    expect(sent?.source.type).toBe("browser");
    expect(sent?.source.id).toBe("test-app");
    expect(sent?.source.sdk).toBe("web");
    expect(sent?.source.sdk_version).toBe("0.0.0-test");
    expect(sent?.identity.anonymous_id).toMatch(/^anon_/);
    expect(sent?.identity.session_id).toMatch(/^sess_/);
    expect(sent?.context.locale).toBe("pt-BR");
    expect(sent?.context.ip).toBe("203.0.113.10");
  });

  it("identify attaches customer_id to subsequent events", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisWebSdk(baseOptions({ transport }));
    await sdk.track("page.viewed", {});
    sdk.identify("cus_123");
    await sdk.track("page.viewed", {});
    await sdk.flush();
    const events = transport.sends[0]?.events ?? [];
    expect(events[0]?.identity.customer_id).toBeNull();
    expect(events[1]?.identity.customer_id).toBe("cus_123");
  });
});

// ---- priority overflow ------------------------------------------------

describe("PolarisWebSdk priority overflow", () => {
  it("drops oldest low first when queue overflows", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const onDrop = vi.fn();
    const sdk = new PolarisWebSdk(
      baseOptions({
        transport,
        maxQueueSize: 3,
        batchSize: 50,
        diagnostics: { onDrop },
      }),
    );
    await sdk.track("page.viewed", { i: 1 }, { priority: "low" });
    await sdk.track("page.viewed", { i: 2 }, { priority: "high" });
    await sdk.track("page.viewed", { i: 3 }, { priority: "normal" });
    await sdk.track("page.viewed", { i: 4 }, { priority: "normal" });
    // The low-priority entry (i=1) should be evicted.
    expect(onDrop).toHaveBeenCalledOnce();
    const droppedEntry = onDrop.mock.calls[0]?.[0];
    expect(droppedEntry?.priority).toBe("low");
    const droppedReason = onDrop.mock.calls[0]?.[1];
    expect(droppedReason).toBe("queue_overflow");
  });

  it("rejects a low incoming when the queue is full of higher priorities (track does not throw)", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const onDrop = vi.fn();
    const sdk = new PolarisWebSdk(
      baseOptions({
        transport,
        maxQueueSize: 2,
        batchSize: 50,
        diagnostics: { onDrop },
      }),
    );
    await sdk.track("page.viewed", { i: 1 }, { priority: "high" });
    await sdk.track("page.viewed", { i: 2 }, { priority: "high" });
    // This call should NOT throw — the architecture doc is explicit that
    // track() does not throw on overflow.
    await expect(sdk.track("page.viewed", { i: 3 }, { priority: "low" })).resolves.toMatch(
      /^[0-9a-f]{8}-/,
    );
    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop.mock.calls[0]?.[1]).toBe("queue_overflow");
  });
});

// ---- retry coordinator -----------------------------------------------

describe("PolarisWebSdk retry coordinator", () => {
  it("preserves event_id across transient retries", async () => {
    let attempts = 0;
    const transport = new FakeTransport(async (_a, events) => {
      attempts += 1;
      if (attempts < 3) {
        throw new TransportError("503 transient", { retryable: true, status: 503 });
      }
      return acceptAll(events);
    });
    const sdk = new PolarisWebSdk(baseOptions({ transport, batchSize: 5 }));
    const idA = await sdk.track("page.viewed", { i: 1 });
    const idB = await sdk.track("page.viewed", { i: 2 });
    const result = await sdk.flush();
    expect(result.delivered).toBe(2);
    expect(transport.sends.length).toBe(3);
    for (const send of transport.sends) {
      expect(send.events.map((e) => e.event_id)).toEqual([idA, idB]);
    }
  });

  it("does not retry permanent transport errors (4xx) and surfaces onDrop", async () => {
    const onDrop = vi.fn();
    const onError = vi.fn();
    const transport = new FakeTransport(async () => {
      throw new TransportError("401 forbidden", { retryable: false, status: 401 });
    });
    const sdk = new PolarisWebSdk(baseOptions({ transport, diagnostics: { onDrop, onError } }));
    await sdk.track("page.viewed", {});
    const result = await sdk.flush();
    expect(result.delivered).toBe(0);
    expect(result.dropped).toBe(1);
    expect(transport.sends.length).toBe(1);
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), "permanent_failure");
    expect(onError).toHaveBeenCalled();
  });

  it("drops events the ingester marks as permanently rejected", async () => {
    const onDrop = vi.fn();
    const transport = new FakeTransport(async (_a, events) => {
      const [first, ...rest] = events;
      return {
        accepted: rest.map((e) => ({ event_id: e.event_id, status: "accepted" as const })),
        rejected: first
          ? [
              {
                event_id: first.event_id,
                status: "rejected" as const,
                reason: "schema_validation_failed",
                retryable: false,
              },
            ]
          : [],
      };
    });
    const sdk = new PolarisWebSdk(
      baseOptions({ transport, batchSize: 5, diagnostics: { onDrop } }),
    );
    await sdk.track("page.viewed", { i: 1 });
    await sdk.track("page.viewed", { i: 2 });
    const result = await sdk.flush();
    expect(result.delivered).toBe(1);
    expect(result.dropped).toBe(1);
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it("re-queues retryable rejections with same event_id for next flush", async () => {
    let call = 0;
    const transport = new FakeTransport(async (_a, events) => {
      call += 1;
      if (call === 1) {
        return {
          accepted: [],
          rejected: events.map((e) => ({
            event_id: e.event_id,
            status: "rejected" as const,
            reason: "transient_overload",
            retryable: true,
          })),
        };
      }
      return acceptAll(events);
    });
    const sdk = new PolarisWebSdk(
      baseOptions({
        transport,
        retry: {
          maxRetries: 0,
          initialDelayMs: 1,
          maxDelayMs: 1,
          backoffMultiplier: 1,
          jitterRatio: 0,
        },
        batchSize: 5,
      }),
    );
    const id = await sdk.track("page.viewed", {});
    const first = await sdk.flush();
    expect(first.delivered).toBe(0);
    expect(first.queued).toBe(1);
    const second = await sdk.flush();
    expect(second.delivered).toBe(1);
    expect(transport.sends.length).toBe(2);
    expect(transport.sends[0]?.events[0]?.event_id).toBe(id);
    expect(transport.sends[1]?.events[0]?.event_id).toBe(id);
  });

  it("invokes onRetry per attempt with the original entry", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const transport = new FakeTransport(async (_a, events) => {
      calls += 1;
      if (calls < 2) throw new TransportError("transient", { retryable: true, status: 502 });
      return acceptAll(events);
    });
    const sdk = new PolarisWebSdk(
      baseOptions({
        transport,
        diagnostics: { onRetry },
      }),
    );
    const id = await sdk.track("page.viewed", {});
    await sdk.flush();
    expect(onRetry).toHaveBeenCalled();
    const firstCall = onRetry.mock.calls[0];
    const passedEntry = firstCall?.[0] as { payload: { event_id: string } } | undefined;
    expect(passedEntry?.payload.event_id).toBe(id);
  });
});

// ---- lifecycle: eager + steady + pagehide ----------------------------

describe("PolarisWebSdk lifecycle", () => {
  it("eager-flush window coalesces a track burst into one request", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport(async (_a, e) => acceptAll(e));
      const sdk = new PolarisWebSdk({
        ...baseOptions({ transport, batchSize: 50 }),
        startupEagerFlushWindowMs: 15_000,
        startupEagerFlushDebounceMs: 100,
        steadyFlushIntervalMs: 5_000,
      });
      await sdk.track("page.viewed", { i: 1 });
      await sdk.track("page.viewed", { i: 2 });
      await sdk.track("page.viewed", { i: 3 });
      expect(transport.sends.length).toBe(0);
      // Advance past the 100ms debounce.
      await vi.advanceTimersByTimeAsync(150);
      expect(transport.sends.length).toBe(1);
      expect(transport.sends[0]?.events.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("steady-mode interval fires the next flush automatically", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport(async (_a, e) => acceptAll(e));
      const sdk = new PolarisWebSdk({
        ...baseOptions({ transport, batchSize: 50 }),
        startupEagerFlushWindowMs: 0,
        startupEagerFlushDebounceMs: 100,
        steadyFlushIntervalMs: 5_000,
      });
      await sdk.track("page.viewed", {});
      // Steady interval flushes after 5s.
      await vi.advanceTimersByTimeAsync(5_001);
      expect(transport.sends.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pagehide triggers an urgent flush via sendBeacon", async () => {
    const fakeBeacon = vi.fn(() => true);
    const fakeFetch = vi.fn(async () => new Response("", { status: 200 }));
    const sdk = await PolarisWebSdk.create({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      source: { id: "test-app", sdkVersion: "0.0.0-test" },
      startupEagerFlushWindowMs: 0,
      startupEagerFlushDebounceMs: 100,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: true,
      transport: {
        send: async (events, mode) => {
          if (mode === "urgent") {
            fakeBeacon(JSON.stringify({ events }));
            return {
              accepted: events.map((e) => ({
                event_id: e.event_id,
                status: "accepted" as const,
              })),
              rejected: [],
            };
          }
          await fakeFetch();
          return {
            accepted: events.map((e) => ({
              event_id: e.event_id,
              status: "accepted" as const,
            })),
            rejected: [],
          };
        },
      },
    });
    await sdk.track("page.viewed", {});
    window.dispatchEvent(new Event("pagehide"));
    // Microtask boundary so the fire-and-forget urgent flush completes.
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeBeacon).toHaveBeenCalled();
  });
});

// ---- close + after-close behaviour -----------------------------------

describe("PolarisWebSdk.close", () => {
  it("attempts a final urgent flush before tearing down", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisWebSdk(baseOptions({ transport }));
    await sdk.track("page.viewed", {});
    await sdk.close();
    expect(transport.closed).toBe(true);
    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0]?.mode).toBe("urgent");
  });

  it("rejects track calls after close", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisWebSdk(baseOptions({ transport }));
    await sdk.close();
    await expect(sdk.track("page.viewed", {})).rejects.toThrowError(/close/);
  });

  it("is idempotent", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisWebSdk(baseOptions({ transport }));
    await sdk.close();
    await expect(sdk.close()).resolves.toBeUndefined();
  });
});

// ---- factory: PolarisWebSdk.create -----------------------------------

describe("PolarisWebSdk.create — async factory", () => {
  it("selects IndexedDB when a factory is available", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    // Inject our own IDBFactory through window.indexedDB. happy-dom does
    // not implement IndexedDB so we have to wire it manually.
    const factory = new IDBFactory();
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: factory,
    });
    try {
      const sdk = await PolarisWebSdk.create({
        ...baseOptions({ transport }),
        window,
      });
      await sdk.track("page.viewed", {});
      await sdk.flush();
      expect(transport.sends.length).toBe(1);
      await sdk.close();
    } finally {
      // Reset the property descriptor; happy-dom doesn't expose indexedDB
      // by default so deleting is safe.
      Reflect.deleteProperty(window, "indexedDB");
    }
  });

  it("falls back to localStorage when IndexedDB is unavailable", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = await PolarisWebSdk.create({
      ...baseOptions({ transport }),
      window,
    });
    await sdk.track("page.viewed", {});
    await sdk.flush();
    expect(transport.sends.length).toBe(1);
    await sdk.close();
  });
});
