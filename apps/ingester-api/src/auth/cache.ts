/**
 * In-memory LRU+TTL cache for resolved API key records.
 *
 * The ingester hot path is `parse header -> lookup -> verify hash -> stamp`.
 * The lookup step talks to PostgreSQL through `@polaris/shared-db`. Without a
 * cache that round trip dominates the latency profile under steady load.
 * Redis-backed cache is a future optimisation (see
 * `docs/architecture/02-control-plane.md` "Redis Role"); v1 uses an in-process
 * cache because it removes a network hop without adding a deployment
 * dependency.
 *
 * Properties of this cache:
 *
 *   - **TTL.** Entries expire after a configurable wall-clock duration. A
 *     revoked-then-rotated key remains live in the cache for at most one TTL
 *     window. The default TTL (60s) bounds that window without making the
 *     hot path chatty.
 *   - **LRU eviction.** When the cache is full, the least-recently-used entry
 *     is evicted. Bounded memory matters because the cache key is the public
 *     `api_key_id` (effectively unbounded on hostile traffic).
 *   - **Negative results.** A `null` lookup result is cached for a shorter
 *     `negativeTtlMs` window so probe traffic (random keys) does not hammer
 *     PostgreSQL. The window is short by default (5s) so genuine new keys
 *     become live quickly after issuance.
 *   - **No locking around concurrent misses.** Two concurrent misses for the
 *     same key cause two PostgreSQL lookups. The cost is small (one extra
 *     SELECT) and avoiding it adds a Promise registry that is easy to leak.
 *
 * The cache is intentionally a single small file with zero deps. Pulling in
 * `lru-cache` would add a runtime dep for ~50 lines of behaviour.
 */

import type { ApiKeyRecord, ApiKeyRepository } from "./repository.js";

/** Options controlling the cache behaviour. Both TTLs are wall-clock ms. */
export interface ApiKeyCacheOptions {
  /** Underlying repository the cache wraps. */
  readonly repository: ApiKeyRepository;
  /** Maximum number of cached entries. Defaults to 1024. */
  readonly maxEntries?: number;
  /** TTL for found entries. Defaults to 60_000 ms. */
  readonly ttlMs?: number;
  /** TTL for `null` results. Defaults to 5_000 ms. */
  readonly negativeTtlMs?: number;
  /** Override `Date.now` for tests. */
  readonly now?: () => number;
}

interface CacheEntry {
  /** Cached value. `null` is a real negative result (no such key). */
  readonly record: ApiKeyRecord | null;
  /** Absolute expiry timestamp (ms). */
  readonly expiresAt: number;
}

/**
 * Wraps an {@link ApiKeyRepository} with an LRU+TTL cache. Implements the
 * same {@link ApiKeyRepository} interface so the auth service does not know
 * (or care) whether it is talking to PostgreSQL or the cache.
 */
export class ApiKeyCache implements ApiKeyRepository {
  readonly #repo: ApiKeyRepository;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #negativeTtlMs: number;
  readonly #now: () => number;
  // Map preserves insertion order; we use that for the LRU bookkeeping by
  // deleting + re-inserting on every read/write so the iterator's first entry
  // is always the LRU candidate.
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: ApiKeyCacheOptions) {
    this.#repo = options.repository;
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#negativeTtlMs = options.negativeTtlMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    if (this.#maxEntries < 1) {
      throw new RangeError("ApiKeyCache.maxEntries must be >= 1");
    }
    if (this.#ttlMs < 0 || this.#negativeTtlMs < 0) {
      throw new RangeError("ApiKeyCache TTLs must be >= 0");
    }
  }

  /** Number of entries currently held. Mostly useful for tests. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Drop every cached entry. Useful in tests and as a future hook for the
   * lifecycle CLI ("after creating/revoking a key, ask the ingester to
   * invalidate"). The ingester does not currently expose an HTTP route for
   * the latter; the TTL provides a bounded staleness window.
   */
  clear(): void {
    this.#entries.clear();
  }

  /**
   * Look up a key by its public id. Hits the cache when fresh; falls through
   * to the underlying repository on miss or stale entry; caches the result
   * either way.
   */
  async findById(apiKeyId: string): Promise<ApiKeyRecord | null> {
    const now = this.#now();
    const existing = this.#entries.get(apiKeyId);
    if (existing !== undefined) {
      if (existing.expiresAt > now) {
        // LRU bookkeeping: move to most-recently-used position.
        this.#entries.delete(apiKeyId);
        this.#entries.set(apiKeyId, existing);
        return existing.record;
      }
      this.#entries.delete(apiKeyId);
    }
    const record = await this.#repo.findById(apiKeyId);
    const ttl = record === null ? this.#negativeTtlMs : this.#ttlMs;
    this.#entries.set(apiKeyId, { record, expiresAt: now + ttl });
    this.#evictIfFull();
    return record;
  }

  #evictIfFull(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
