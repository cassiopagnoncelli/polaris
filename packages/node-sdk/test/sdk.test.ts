import { describe, expect, it, vi } from "vitest";

import { PolarisNodeSdk } from "../src/sdk.js";
import { TransportError } from "../src/transport/https.js";
import type { PolarisSdkOptions, QueuedEvent, Transport, TransportResult } from "../src/types.js";

/** Per-test transport spy: records sends and replays canned results. */
class FakeTransport implements Transport {
  public readonly sends: Array<readonly QueuedEvent[]> = [];
  public closed = false;
  private readonly behaviour: (
    attempt: number,
    events: readonly QueuedEvent[],
  ) => Promise<TransportResult>;

  public constructor(
    behaviour: (attempt: number, events: readonly QueuedEvent[]) => Promise<TransportResult>,
  ) {
    this.behaviour = behaviour;
  }

  public async send(events: readonly QueuedEvent[]): Promise<TransportResult> {
    this.sends.push(events);
    return this.behaviour(this.sends.length, events);
  }

  public close(): void {
    this.closed = true;
  }
}

function acceptAll(events: readonly QueuedEvent[]): TransportResult {
  return {
    accepted: events.map((e) => ({ event_id: e.event_id, status: "accepted" as const })),
    rejected: [],
  };
}

function baseOptions(overrides: Partial<PolarisSdkOptions> = {}): PolarisSdkOptions {
  return {
    endpoint: "https://example.invalid/events",
    apiKey: "test-key",
    source: { type: "backend", id: "checkout-api", sdkVersion: "0.0.0-test" },
    flushIntervalMs: 0, // disable interval timer in unit tests
    batchSize: 50,
    retry: { initialDelayMs: 1, maxDelayMs: 5, backoffMultiplier: 2, jitterRatio: 0 },
    shutdownTimeoutMs: 100,
    ...overrides,
  };
}

describe("PolarisNodeSdk constructor", () => {
  it("requires endpoint, apiKey, and source", () => {
    expect(
      () =>
        new PolarisNodeSdk({
          endpoint: "",
          apiKey: "x",
          source: { type: "backend", id: "x" },
        }),
    ).toThrowError(/endpoint/);
    expect(
      () =>
        new PolarisNodeSdk({
          endpoint: "https://x",
          apiKey: "",
          source: { type: "backend", id: "x" },
        }),
    ).toThrowError(/apiKey/);
    expect(
      () =>
        new PolarisNodeSdk({
          endpoint: "https://x",
          apiKey: "x",
          source: { type: "backend", id: "" },
        }),
    ).toThrowError(/source\.id/);
  });

  it("rejects invalid sizing parameters", () => {
    expect(
      () =>
        new PolarisNodeSdk({
          ...baseOptions(),
          maxQueueSize: 0,
        }),
    ).toThrowError(/maxQueueSize/);
    expect(
      () =>
        new PolarisNodeSdk({
          ...baseOptions(),
          batchSize: -1,
        }),
    ).toThrowError(/batchSize/);
    expect(
      () =>
        new PolarisNodeSdk({
          ...baseOptions(),
          flushIntervalMs: -1,
        }),
    ).toThrowError(/flushIntervalMs/);
  });

  it("seeds default identity with anon_/sess_ identifiers", () => {
    const sdk = new PolarisNodeSdk(baseOptions());
    const id = sdk.getIdentity();
    expect(id.anonymous_id).toMatch(/^anon_/);
    expect(id.session_id).toMatch(/^sess_/);
    expect(id.customer_id).toBeNull();
    expect(id.device_id).toBeNull();
  });

  it("getIdentity returns a frozen snapshot (callers cannot mutate SDK state)", () => {
    const sdk = new PolarisNodeSdk(baseOptions());
    const id = sdk.getIdentity();
    expect(Object.isFrozen(id)).toBe(true);
  });
});

describe("PolarisNodeSdk.track (queue-first)", () => {
  it("enqueues before any transport call (no eager flush below batchSize)", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(
      baseOptions({
        batchSize: 10,
        transport,
      }),
    );
    await sdk.track("payment.approved", { amount: 1 });
    await sdk.track("payment.approved", { amount: 2 });
    // The queue should contain 2 events and no transport call should have happened.
    expect(transport.sends.length).toBe(0);
    const flush = await sdk.flush();
    expect(flush.delivered).toBe(2);
    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0]?.length).toBe(2);
  });

  it("returns a UUIDv7-shaped event_id", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(baseOptions({ transport }));
    const id = await sdk.track("payment.approved", {});
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("triggers an eager flush once batchSize is reached", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(
      baseOptions({
        batchSize: 2,
        transport,
      }),
    );
    await sdk.track("payment.approved", {});
    expect(transport.sends.length).toBe(0);
    await sdk.track("payment.approved", {});
    // Eager flush is scheduled asynchronously; give the microtask queue a beat.
    await sdk.flush();
    expect(transport.sends.length).toBeGreaterThanOrEqual(1);
  });

  it("drops events when the queue is full and notifies onDrop", async () => {
    const onDrop = vi.fn();
    const onDiagnostic = vi.fn();
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(
      baseOptions({
        maxQueueSize: 1,
        batchSize: 10,
        transport,
        diagnostics: { onDrop, onDiagnostic },
      }),
    );
    await sdk.track("payment.approved", { i: 1 });
    await sdk.track("payment.approved", { i: 2 });
    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop.mock.calls[0]?.[1]).toBe("queue_overflow");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "queue_overflow" }));
  });

  it("rejects invalid event names without enqueueing", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(baseOptions({ transport }));
    await expect(sdk.track("bad name", {})).rejects.toThrowError();
    await sdk.flush();
    expect(transport.sends.length).toBe(0);
  });

  it("stamps source, identity, and context onto every event", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(
      baseOptions({
        transport,
        defaultContext: { locale: "pt-BR" },
        identity: { anonymous_id: "anon_x", session_id: "sess_y", customer_id: null },
      }),
    );
    await sdk.track("payment.approved", { amount: 1 }, { context: { ip: "203.0.113.10" } });
    await sdk.flush();
    const sent = transport.sends[0]?.[0];
    expect(sent?.source).toEqual({
      type: "backend",
      id: "checkout-api",
      sdk: "node",
      sdk_version: "0.0.0-test",
    });
    expect(sent?.identity.anonymous_id).toBe("anon_x");
    expect(sent?.identity.session_id).toBe("sess_y");
    expect(sent?.context.locale).toBe("pt-BR");
    expect(sent?.context.ip).toBe("203.0.113.10");
  });
});

describe("PolarisNodeSdk identify / reset", () => {
  it("identify attaches customer_id to subsequent events", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(baseOptions({ transport }));
    await sdk.track("page.viewed", {});
    sdk.identify("cus_123", { tier: "gold" });
    await sdk.track("page.viewed", {});
    await sdk.flush();
    const events = transport.sends[0] ?? [];
    expect(events[0]?.identity.customer_id).toBeNull();
    expect(events[1]?.identity.customer_id).toBe("cus_123");
  });

  it("reset rotates session and anonymous by default", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(baseOptions({ transport }));
    sdk.identify("cus_123");
    await sdk.track("page.viewed", {});
    sdk.reset();
    await sdk.track("page.viewed", {});
    await sdk.flush();
    const events = transport.sends[0] ?? [];
    const before = events[0];
    const after = events[1];
    expect(after?.identity.customer_id).toBeNull();
    expect(after?.identity.session_id).not.toBe(before?.identity.session_id);
    expect(after?.identity.anonymous_id).not.toBe(before?.identity.anonymous_id);
  });

  it("reset({ anonymous: false }) keeps anonymous identity", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(baseOptions({ transport }));
    await sdk.track("page.viewed", {});
    sdk.reset({ anonymous: false });
    await sdk.track("page.viewed", {});
    await sdk.flush();
    const events = transport.sends[0] ?? [];
    const before = events[0];
    const after = events[1];
    expect(after?.identity.anonymous_id).toBe(before?.identity.anonymous_id);
    expect(after?.identity.session_id).not.toBe(before?.identity.session_id);
  });

  it("identify rejects empty customer_id", () => {
    const sdk = new PolarisNodeSdk(baseOptions());
    expect(() => sdk.identify("")).toThrowError();
  });
});

describe("PolarisNodeSdk retry behaviour", () => {
  it("preserves event_id across transient retries", async () => {
    let attempts = 0;
    const transport = new FakeTransport(async (_a, events) => {
      attempts += 1;
      if (attempts < 3) {
        throw new TransportError("temporary 503", { retryable: true, status: 503 });
      }
      return acceptAll(events);
    });
    const sdk = new PolarisNodeSdk(baseOptions({ transport, batchSize: 5 }));
    const idA = await sdk.track("payment.approved", { i: 1 });
    const idB = await sdk.track("payment.approved", { i: 2 });
    const result = await sdk.flush();
    expect(result.delivered).toBe(2);
    expect(transport.sends.length).toBe(3);
    for (const send of transport.sends) {
      expect(send.map((e) => e.event_id)).toEqual([idA, idB]);
    }
  });

  it("does not retry permanent transport errors and surfaces onDrop", async () => {
    const onDrop = vi.fn();
    const onError = vi.fn();
    const transport = new FakeTransport(async () => {
      throw new TransportError("permanent 401", { retryable: false, status: 401 });
    });
    const sdk = new PolarisNodeSdk(baseOptions({ transport, diagnostics: { onDrop, onError } }));
    await sdk.track("payment.approved", {});
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
    const sdk = new PolarisNodeSdk(
      baseOptions({ transport, batchSize: 5, diagnostics: { onDrop } }),
    );
    await sdk.track("payment.approved", { i: 1 });
    await sdk.track("payment.approved", { i: 2 });
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
    const sdk = new PolarisNodeSdk(
      baseOptions({
        transport,
        // Limit attempts so we land in requeue, not pure inner-loop retry.
        retry: {
          maxAttempts: 1,
          initialDelayMs: 1,
          maxDelayMs: 1,
          backoffMultiplier: 1,
          jitterRatio: 0,
        },
        batchSize: 5,
      }),
    );
    const id = await sdk.track("payment.approved", {});
    const first = await sdk.flush();
    expect(first.delivered).toBe(0);
    expect(first.queued).toBe(1);
    const second = await sdk.flush();
    expect(second.delivered).toBe(1);
    expect(transport.sends.length).toBe(2);
    expect(transport.sends[0]?.[0]?.event_id).toBe(id);
    expect(transport.sends[1]?.[0]?.event_id).toBe(id);
  });
});

describe("PolarisNodeSdk lifecycle", () => {
  it("flush invokes onFlush callback", async () => {
    const onFlush = vi.fn();
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(baseOptions({ transport, diagnostics: { onFlush } }));
    await sdk.track("page.viewed", {});
    await sdk.flush();
    expect(onFlush).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: 1, queued: 0, dropped: 0 }),
    );
  });

  it("close drains queued events and is idempotent", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(baseOptions({ transport }));
    await sdk.track("payment.approved", { i: 1 });
    await sdk.track("payment.approved", { i: 2 });
    await sdk.close();
    expect(transport.closed).toBe(true);
    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0]?.length).toBe(2);
    // Second close is a no-op
    await expect(sdk.close()).resolves.toBeUndefined();
  });

  it("does not register signal handlers by default", () => {
    const before = process.listenerCount("SIGTERM");
    const sdk = new PolarisNodeSdk(baseOptions());
    const after = process.listenerCount("SIGTERM");
    expect(after).toBe(before);
    return sdk.close();
  });

  it("registers signal handlers when autoFlushOnShutdown is true", async () => {
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sigTermBefore = process.listenerCount("SIGTERM");
    const sigIntBefore = process.listenerCount("SIGINT");
    const sdk = new PolarisNodeSdk(baseOptions({ transport, autoFlushOnShutdown: true }));
    expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigIntBefore + 1);
    await sdk.close();
    expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigIntBefore);
  });

  it("rejects calls after close()", async () => {
    const sdk = new PolarisNodeSdk(baseOptions());
    await sdk.close();
    await expect(sdk.track("page.viewed", {})).rejects.toThrowError(/close/);
    expect(() => sdk.identify("cus_x")).toThrowError(/close/);
    expect(() => sdk.reset()).toThrowError(/close/);
  });

  it("close drops residual events on shutdown timeout", async () => {
    const onDrop = vi.fn();
    // Transport that never resolves so the drain stalls.
    const transport: Transport = {
      send: () =>
        new Promise<TransportResult>(() => {
          /* never resolve */
        }),
    };
    const sdk = new PolarisNodeSdk(
      baseOptions({
        transport,
        diagnostics: { onDrop },
        shutdownTimeoutMs: 20,
        retry: {
          maxAttempts: 1,
          initialDelayMs: 1,
          maxDelayMs: 1,
          backoffMultiplier: 1,
          jitterRatio: 0,
        },
      }),
    );
    await sdk.track("page.viewed", {});
    await sdk.close();
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), "shutdown_timeout");
  });
});

describe("PolarisNodeSdk diagnostics", () => {
  it("onRetry is invoked per retry attempt with the original event", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const transport = new FakeTransport(async (_a, events) => {
      calls += 1;
      if (calls < 2) throw new TransportError("transient", { retryable: true, status: 502 });
      return acceptAll(events);
    });
    const sdk = new PolarisNodeSdk(
      baseOptions({
        transport,
        diagnostics: { onRetry },
        retry: {
          maxAttempts: 5,
          initialDelayMs: 1,
          maxDelayMs: 1,
          backoffMultiplier: 1,
          jitterRatio: 0,
        },
      }),
    );
    const id = await sdk.track("page.viewed", {});
    await sdk.flush();
    expect(onRetry).toHaveBeenCalled();
    const firstCall = onRetry.mock.calls[0];
    const passedEvent = firstCall?.[0] as { event_id: string } | undefined;
    expect(passedEvent?.event_id).toBe(id);
  });

  it("swallows callback exceptions and surfaces via onError", async () => {
    const onError = vi.fn();
    const transport = new FakeTransport(async (_a, e) => acceptAll(e));
    const sdk = new PolarisNodeSdk(
      baseOptions({
        transport,
        diagnostics: {
          onError,
          onFlush: () => {
            throw new Error("boom");
          },
        },
      }),
    );
    await sdk.track("page.viewed", {});
    await sdk.flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
  });
});
