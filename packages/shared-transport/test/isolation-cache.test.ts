/**
 * Tests for `StreamIsolationCache` and the scoped resolver hookup.
 *
 * Cache behavior mirrors the destination-instance + api-key caches:
 *
 *   - Cache hit returns the cached value without consulting the reader.
 *   - Cache miss falls through to the reader and stores the result.
 *   - TTL expiry triggers a fresh read.
 *   - LRU eviction drops the least-recently-used entry.
 *   - Both positive and negative results are cached (single TTL).
 *
 * Plus the integration with the new `resolveStreamFamilyScoped` helper and
 * the `forEnvironment` adapter that bridges the cache back to the v1
 * `IsolationLookup` contract.
 */
import { describe, expect, it } from "vitest";

import { resolveStreamFamilyScoped } from "../src/stream-family.js";
import {
  InMemoryScopedIsolationLookup,
  type ScopedIsolationLookup,
  StreamIsolationCache,
} from "../src/isolation-cache.js";
import {
  STREAM_FAMILY_ANALYTICS_EVENTS,
  STREAM_FAMILY_ENRICHED_EVENTS,
  STREAM_FAMILY_RAW_EVENTS,
} from "../src/streams.js";

class RecordingReader implements ScopedIsolationLookup {
  public readonly seen: Array<{ family: string; project_id: string; environment: string }> = [];
  public answer: boolean | "boom" = false;

  async isIsolated(family: string, projectId: string, environment: string): Promise<boolean> {
    this.seen.push({ family, project_id: projectId, environment });
    if (this.answer === "boom") {
      throw new Error("boom");
    }
    return this.answer;
  }
}

describe("InMemoryScopedIsolationLookup", () => {
  it("reports the shared topic when no triple is registered", async () => {
    const lookup = new InMemoryScopedIsolationLookup();
    expect(await lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-a", "production")).toBe(false);
  });

  it("reports the dedicated topic for added triples and nothing else", async () => {
    const lookup = new InMemoryScopedIsolationLookup();
    lookup.add(STREAM_FAMILY_RAW_EVENTS, "project-a", "production");
    expect(await lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-a", "production")).toBe(true);
    // Different family — not isolated.
    expect(await lookup.isIsolated(STREAM_FAMILY_ENRICHED_EVENTS, "project-a", "production")).toBe(
      false,
    );
    // Different environment — not isolated.
    expect(await lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-a", "staging")).toBe(false);
    // Different project — not isolated.
    expect(await lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-b", "production")).toBe(false);
  });

  it("supports removal", async () => {
    const lookup = new InMemoryScopedIsolationLookup();
    lookup.add(STREAM_FAMILY_RAW_EVENTS, "project-a", "production");
    lookup.remove(STREAM_FAMILY_RAW_EVENTS, "project-a", "production");
    expect(await lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-a", "production")).toBe(false);
  });
});

describe("StreamIsolationCache", () => {
  it("hits the reader on first miss and serves the cached value on the second call", async () => {
    const reader = new RecordingReader();
    reader.answer = true;
    const cache = new StreamIsolationCache({ reader, now: () => 1_000 });
    expect(await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-iso", "production")).toBe(true);
    expect(await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-iso", "production")).toBe(true);
    expect(reader.seen).toHaveLength(1);
  });

  it("caches negative results too (the resolver path should not re-query on every shared lookup)", async () => {
    const reader = new RecordingReader();
    reader.answer = false;
    const cache = new StreamIsolationCache({ reader, now: () => 1_000 });
    expect(await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-shared", "production")).toBe(
      false,
    );
    expect(await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-shared", "production")).toBe(
      false,
    );
    expect(reader.seen).toHaveLength(1);
  });

  it("re-queries the reader after TTL expiry", async () => {
    let nowValue = 1_000;
    const reader = new RecordingReader();
    reader.answer = false;
    const cache = new StreamIsolationCache({ reader, ttlMs: 100, now: () => nowValue });
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-shared", "production");
    nowValue = 1_050;
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-shared", "production");
    expect(reader.seen).toHaveLength(1); // still inside TTL
    nowValue = 1_200;
    reader.answer = true; // simulate a `polaris topics isolate` landing
    expect(await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-shared", "production")).toBe(
      true,
    );
    expect(reader.seen).toHaveLength(2);
  });

  it("distinguishes entries by environment", async () => {
    const reader = new RecordingReader();
    const cache = new StreamIsolationCache({ reader, now: () => 1_000 });
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-x", "production");
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-x", "staging");
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-x", "development");
    expect(reader.seen).toHaveLength(3);
  });

  it("distinguishes entries by family", async () => {
    const reader = new RecordingReader();
    const cache = new StreamIsolationCache({ reader, now: () => 1_000 });
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-x", "production");
    await cache.isIsolated(STREAM_FAMILY_ENRICHED_EVENTS, "project-x", "production");
    await cache.isIsolated(STREAM_FAMILY_ANALYTICS_EVENTS, "project-x", "production");
    expect(reader.seen).toHaveLength(3);
  });

  it("evicts the LRU entry once full", async () => {
    const reader = new RecordingReader();
    const cache = new StreamIsolationCache({ reader, maxEntries: 2, now: () => 1_000 });
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "p1", "production");
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "p2", "production");
    // Re-touch p1 so p2 becomes the LRU candidate.
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "p1", "production");
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "p3", "production");
    expect(cache.size).toBe(2);
    // p2 should be a fresh miss now.
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "p2", "production");
    expect(reader.seen.filter((s) => s.project_id === "p2")).toHaveLength(2);
  });

  it("rejects invalid maxEntries and ttl values", () => {
    const reader = new RecordingReader();
    expect(() => new StreamIsolationCache({ reader, maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => new StreamIsolationCache({ reader, ttlMs: -1 })).toThrow(/ttlMs/);
  });

  it("clear() drops every entry so the next lookup re-reads", async () => {
    const reader = new RecordingReader();
    const cache = new StreamIsolationCache({ reader, now: () => 1_000 });
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "p1", "production");
    cache.clear();
    await cache.isIsolated(STREAM_FAMILY_RAW_EVENTS, "p1", "production");
    expect(reader.seen).toHaveLength(2);
  });

  it("forEnvironment(env) returns a v1 IsolationLookup pinned to that env", async () => {
    const reader = new RecordingReader();
    reader.answer = true;
    const cache = new StreamIsolationCache({ reader, now: () => 1_000 });
    const pinned = cache.forEnvironment("production");
    expect(await pinned.isIsolated(STREAM_FAMILY_RAW_EVENTS, "project-a")).toBe(true);
    expect(reader.seen).toHaveLength(1);
    expect(reader.seen[0]?.environment).toBe("production");
  });
});

describe("resolveStreamFamilyScoped", () => {
  it("returns the shared topic when not isolated", async () => {
    const reader = new RecordingReader();
    reader.answer = false;
    expect(
      await resolveStreamFamilyScoped(STREAM_FAMILY_RAW_EVENTS, "project-shared", "production", reader),
    ).toBe("raw.events");
  });

  it("returns the dedicated topic when isolated", async () => {
    const reader = new RecordingReader();
    reader.answer = true;
    expect(
      await resolveStreamFamilyScoped(STREAM_FAMILY_RAW_EVENTS, "project-iso", "production", reader),
    ).toBe("raw.events.project-iso");
  });

  it("supports multi-project differentiation (one isolated, one shared)", async () => {
    const lookup = new InMemoryScopedIsolationLookup();
    lookup.add(STREAM_FAMILY_RAW_EVENTS, "project-iso", "production");
    expect(
      await resolveStreamFamilyScoped(STREAM_FAMILY_RAW_EVENTS, "project-iso", "production", lookup),
    ).toBe("raw.events.project-iso");
    expect(
      await resolveStreamFamilyScoped(STREAM_FAMILY_RAW_EVENTS, "project-shared", "production", lookup),
    ).toBe("raw.events");
  });

  it("respects environment scope (isolated in prod, shared in dev)", async () => {
    const lookup = new InMemoryScopedIsolationLookup();
    lookup.add(STREAM_FAMILY_RAW_EVENTS, "project-x", "production");
    expect(
      await resolveStreamFamilyScoped(STREAM_FAMILY_RAW_EVENTS, "project-x", "production", lookup),
    ).toBe("raw.events.project-x");
    expect(
      await resolveStreamFamilyScoped(STREAM_FAMILY_RAW_EVENTS, "project-x", "development", lookup),
    ).toBe("raw.events");
  });

  it("rejects non-canonical families", async () => {
    const lookup = new InMemoryScopedIsolationLookup();
    await expect(
      resolveStreamFamilyScoped("not.a.family", "project-x", "production", lookup),
    ).rejects.toThrow();
  });
});
