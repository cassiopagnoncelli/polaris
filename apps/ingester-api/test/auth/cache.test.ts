import { describe, expect, it } from "vitest";

import { ApiKeyCache } from "../../src/auth/cache.js";
import type { ApiKeyRecord, ApiKeyRepository } from "../../src/auth/repository.js";

function record(apiKeyId: string): ApiKeyRecord {
  return {
    apiKeyId,
    projectId: "p1",
    environment: "production",
    sourceId: "src",
    sourceType: "web",
    hash: "h",
    hashAlgorithm: "argon2id",
    status: "active",
  };
}

class CountingRepo implements ApiKeyRepository {
  public count = 0;
  constructor(private readonly store: Map<string, ApiKeyRecord>) {}
  async findById(id: string): Promise<ApiKeyRecord | null> {
    this.count += 1;
    return this.store.get(id) ?? null;
  }
}

describe("ApiKeyCache", () => {
  it("caches positive results within the TTL", async () => {
    const store = new Map<string, ApiKeyRecord>([["k1", record("k1")]]);
    const repo = new CountingRepo(store);
    let nowMs = 1_000_000;
    const cache = new ApiKeyCache({
      repository: repo,
      ttlMs: 1_000,
      negativeTtlMs: 100,
      now: () => nowMs,
    });

    const first = await cache.findById("k1");
    expect(first?.apiKeyId).toBe("k1");
    expect(repo.count).toBe(1);

    // Within TTL, hits skip the repo.
    nowMs += 500;
    await cache.findById("k1");
    expect(repo.count).toBe(1);

    // After TTL, the next call re-queries.
    nowMs += 1_000;
    await cache.findById("k1");
    expect(repo.count).toBe(2);
  });

  it("caches negative results with a shorter TTL", async () => {
    const repo = new CountingRepo(new Map());
    let nowMs = 0;
    const cache = new ApiKeyCache({
      repository: repo,
      ttlMs: 60_000,
      negativeTtlMs: 1_000,
      now: () => nowMs,
    });

    expect(await cache.findById("missing")).toBeNull();
    expect(await cache.findById("missing")).toBeNull();
    expect(repo.count).toBe(1);

    nowMs += 1_500;
    expect(await cache.findById("missing")).toBeNull();
    expect(repo.count).toBe(2);
  });

  it("evicts least-recently-used entries when the cache is full", async () => {
    const store = new Map<string, ApiKeyRecord>(["a", "b", "c"].map((id) => [id, record(id)]));
    const repo = new CountingRepo(store);
    const cache = new ApiKeyCache({
      repository: repo,
      maxEntries: 2,
      ttlMs: 60_000,
      negativeTtlMs: 5_000,
    });

    await cache.findById("a");
    await cache.findById("b");
    // Touch `a` so `b` becomes the LRU candidate.
    await cache.findById("a");
    await cache.findById("c"); // evicts `b`
    expect(cache.size).toBe(2);

    // `b` should be a miss now → repo lookup count grows.
    const before = repo.count;
    await cache.findById("b");
    expect(repo.count).toBe(before + 1);
  });

  it("clear() drops every entry", async () => {
    const store = new Map<string, ApiKeyRecord>([["k1", record("k1")]]);
    const repo = new CountingRepo(store);
    const cache = new ApiKeyCache({ repository: repo, ttlMs: 60_000 });
    await cache.findById("k1");
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    await cache.findById("k1");
    expect(repo.count).toBe(2);
  });

  it("rejects invalid options", () => {
    expect(
      () =>
        new ApiKeyCache({
          repository: new CountingRepo(new Map()),
          maxEntries: 0,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new ApiKeyCache({
          repository: new CountingRepo(new Map()),
          ttlMs: -1,
        }),
    ).toThrow(RangeError);
  });
});
