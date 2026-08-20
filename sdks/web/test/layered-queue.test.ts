// @vitest-environment happy-dom
/**
 * `LayeredEventQueue` — capability detection + routing.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * Tests cover:
 *
 *   - IndexedDB is selected when available
 *   - localStorage is selected when IndexedDB is missing
 *   - memory is the always-available final fallback
 *   - the queue is plumbed correctly to its inner layer
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { LayeredEventQueue } from "../src/queue/layered-queue.js";

beforeEach(() => {
  window.localStorage.clear();
});

describe("LayeredEventQueue capability selection", () => {
  it("lands on IndexedDB when an IDBFactory is available", async () => {
    const q = await LayeredEventQueue.create({
      maxSize: 10,
      indexedDB: new IDBFactory(),
      localStorage: window.localStorage,
    });
    expect(q.layer).toBe("indexeddb");
  });

  it("falls forward to localStorage when IndexedDB is not provided", async () => {
    const q = await LayeredEventQueue.create({
      maxSize: 10,
      indexedDB: undefined,
      localStorage: window.localStorage,
    });
    expect(q.layer).toBe("localstorage");
  });

  it("falls forward to memory when neither IndexedDB nor localStorage is provided", async () => {
    const q = await LayeredEventQueue.create({
      maxSize: 10,
      indexedDB: undefined,
      localStorage: undefined,
    });
    expect(q.layer).toBe("memory");
  });

  it("respects a custom layerOrder that promotes memory above localStorage", async () => {
    const q = await LayeredEventQueue.create({
      maxSize: 10,
      indexedDB: undefined,
      localStorage: window.localStorage,
      layerOrder: ["memory"],
    });
    expect(q.layer).toBe("memory");
  });

  it("delegates to the inner queue (enqueue / size / drain)", async () => {
    const q = await LayeredEventQueue.create({
      maxSize: 10,
      indexedDB: undefined,
      localStorage: undefined,
    });
    const sample = {
      payload: {
        event_id: "00000000-0000-7000-8000-000000000001",
        event: "test.event",
        schema_version: 1,
        occurred_at: new Date(1).toISOString(),
        source: {
          type: "browser" as const,
          id: "test",
          sdk: "web",
          sdk_version: "0.0.0",
        },
        identity: { anonymous_id: "a", session_id: "s", customer_id: null, device_id: null },
        context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
        properties: {},
      },
      priority: "normal" as const,
      attempts: 0,
      enqueued_at: 1,
    };
    await q.enqueue(sample);
    expect(await q.size()).toBe(1);
    const drained = await q.drainAll();
    expect(drained.length).toBe(1);
  });
});
