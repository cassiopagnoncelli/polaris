/**
 * In-memory TTL cache for per-source origin allow-lists.
 *
 * The ingester resolves the allow-list on every browser request to the
 * `POST /v1/events` endpoint. Without a cache the hot path would hit
 * PostgreSQL once per request; with the cache we get exact-match O(1)
 * resolution and a bounded staleness window.
 *
 * The TTL is intentionally short (60s by default) so a removed origin
 * propagates fast. Operators can override via
 * `POLARIS_INGEST_ORIGIN_CACHE_TTL_MS`.
 *
 * Negative results (no rows for a `(project, source, env)` triple) are
 * cached for the same window — deny-by-default is the safe failure mode.
 *
 * The cache is structurally identical to `auth/cache.ts` but holds an
 * `AllowedOriginsResult` (string array) rather than an `ApiKeyRecord | null`.
 * Keeping them separate avoids over-generalising before the second use case.
 */

import type { AllowedOriginsRepository, AllowedOriginsResult, OriginLookupInput } from "./types.js";

export interface AllowedOriginsCacheOptions {
  /** Underlying repository the cache wraps. */
  readonly repository: AllowedOriginsRepository;
  /** Maximum number of cached `(project, source, env)` triples. */
  readonly maxEntries?: number;
  /** TTL for cached entries. Defaults to 60_000 ms. */
  readonly ttlMs?: number;
  /** Override `Date.now` for tests. */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly value: AllowedOriginsResult;
  readonly expiresAt: number;
}

/**
 * Build the cache key from the lookup tuple. Keys are namespaced by all
 * three dimensions so the same source in two environments cannot collide.
 */
function cacheKey(input: OriginLookupInput): string {
  return `${input.projectId}\x00${input.sourceId}\x00${input.environment}`;
}

/**
 * Wraps an {@link AllowedOriginsRepository} with a small LRU+TTL cache.
 * Implements the same interface so the guard layer is agnostic to the
 * underlying storage.
 */
export class AllowedOriginsCache implements AllowedOriginsRepository {
  readonly #repo: AllowedOriginsRepository;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: AllowedOriginsCacheOptions) {
    this.#repo = options.repository;
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    if (this.#maxEntries < 1) {
      throw new RangeError("AllowedOriginsCache.maxEntries must be >= 1");
    }
    if (this.#ttlMs < 0) {
      throw new RangeError("AllowedOriginsCache.ttlMs must be >= 0");
    }
  }

  /** Number of cached entries. Mostly useful for tests. */
  get size(): number {
    return this.#entries.size;
  }

  /** Drop every cached entry. Useful in tests and after a config reload. */
  clear(): void {
    this.#entries.clear();
  }

  async findFor(input: OriginLookupInput): Promise<AllowedOriginsResult> {
    const key = cacheKey(input);
    const now = this.#now();
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.expiresAt > now) {
        // LRU bookkeeping: re-insert to move to MRU position.
        this.#entries.delete(key);
        this.#entries.set(key, existing);
        return existing.value;
      }
      this.#entries.delete(key);
    }
    const fresh = await this.#repo.findFor(input);
    this.#entries.set(key, { value: fresh, expiresAt: now + this.#ttlMs });
    this.#evictIfFull();
    return fresh;
  }

  #evictIfFull(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
