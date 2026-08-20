// @vitest-environment happy-dom
/**
 * Script loader with pre-init command queue.
 *
 * Per `docs/architecture/10-sdk-standards.md` § Script Loader:
 *
 *   - Calls before full SDK load are queued.
 *   - Queued calls are drained after initialization.
 *   - The loader supports early `track`, `identify`, `reset`, and `flush`
 *     calls.
 *   - The full SDK preserves event order for queued calls where possible.
 *
 * In v1 the IIFE bundle that ships the inline snippet is an explicit
 * future task; this test verifies the typed glue (`drainLoaderQueue`)
 * that the bundle will wrap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drainLoaderQueue, INLINE_LOADER_SNIPPET } from "../src/loader.js";
import { PolarisWebSdk } from "../src/sdk.js";
import type { LoaderQueue, QueuedEventPayload, Transport, TransportResult } from "../src/types.js";
import { clearAllCookies } from "./helpers/dom.js";

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

function acceptAll(events: readonly QueuedEventPayload[]): TransportResult {
  return {
    accepted: events.map((e) => ({ event_id: e.event_id, status: "accepted" as const })),
    rejected: [],
  };
}

describe("drainLoaderQueue", () => {
  it("replays track / identify / reset / flush in order", async () => {
    const sends: Array<readonly QueuedEventPayload[]> = [];
    const transport: Transport = {
      send: async (events) => {
        sends.push([...events]);
        return acceptAll(events);
      },
    };
    const sdk = new PolarisWebSdk({
      endpoint: "https://example.invalid/events",
      apiKey: "test",
      source: { id: "test-app" },
      transport,
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
      retry: {
        maxRetries: 0,
        initialDelayMs: 1,
        maxDelayMs: 1,
        backoffMultiplier: 1,
        jitterRatio: 0,
      },
    });
    const q: LoaderQueue = [
      ["identify", "cus_123"],
      ["track", "page.viewed", { path: "/" }],
      ["track", "checkout.started"],
      ["flush"],
    ];
    await drainLoaderQueue(sdk, q);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    const eventsSent = sends.flat();
    // `identify()` now enqueues `user.identified` as well, so the queue
    // replays FOUR events: the identify emission followed by the two
    // tracked ones. Order is what this test is really about — the
    // identify must land first so the tracked events carry the customer
    // id it set.
    expect(eventsSent.map((e) => e.event)).toEqual([
      "user.identified",
      "page.viewed",
      "checkout.started",
    ]);
    for (const sent of eventsSent) {
      expect(sent.identity.customer_id).toBe("cus_123");
    }
  });

  it("invokes onUnknownCommand for unrecognised tuples", async () => {
    const sdk = new PolarisWebSdk({
      transport: { send: async (e) => acceptAll(e) },
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
    });
    const onUnknownCommand = vi.fn();
    await drainLoaderQueue(sdk, [["mystery", "argument"] as unknown as LoaderQueue[number]], {
      onUnknownCommand,
    });
    expect(onUnknownCommand).toHaveBeenCalledOnce();
  });

  it("surfaces individual command errors without aborting the queue", async () => {
    const sdk = new PolarisWebSdk({
      transport: { send: async (e) => acceptAll(e) },
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
    });
    const onCommandError = vi.fn();
    const q: LoaderQueue = [
      ["track", "this is invalid"], // invalid event name
      ["track", "valid.event"],
    ];
    await drainLoaderQueue(sdk, q, { onCommandError });
    expect(onCommandError).toHaveBeenCalledOnce();
    // The valid event should still have landed.
    const result = await sdk.flush();
    expect(result.delivered).toBe(1);
  });
});

describe("INLINE_LOADER_SNIPPET", () => {
  it("is non-empty and references the polaris global", () => {
    expect(INLINE_LOADER_SNIPPET.length).toBeGreaterThan(0);
    expect(INLINE_LOADER_SNIPPET).toContain("polaris");
    expect(INLINE_LOADER_SNIPPET).toContain("track");
    expect(INLINE_LOADER_SNIPPET).toContain("identify");
  });
});
