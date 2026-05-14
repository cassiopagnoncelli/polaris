/**
 * TTL+LRU cache for topic-family isolation lookups.
 *
 * The resolver in `topic-family.ts` is consulted on every publish and
 * every consumer subscribe call. Without a cache, each invocation would
 * round-trip to PostgreSQL to ask "is `(family, project_id, environment)`
 * currently isolated?" — the volume share of even one busy project would
 * dominate the latency profile.
 *
 * The cache mirrors the pattern established by
 * `packages/shared-destinations/src/db/destination-instance.ts` (the
 * destination-instance cache) and `apps/ingester-api/src/auth/cache.ts`
 * (the api-key cache):
 *
 *   - **TTL.** Entries expire after a configurable wall-clock duration.
 *     Default 60s. A `polaris topics isolate` activation becomes live
 *     within at most one TTL window after the CLI commits.
 *
 *   - **LRU eviction.** Bounded memory matters because the cache key is
 *     a tuple of operator-controlled values; a runaway list query could
 *     otherwise blow the cache.
 *
 *   - **Negative results.** A `false` lookup (the project is NOT
 *     isolated for this family) is cached for the SAME duration as a
 *     positive result. This is a deliberate departure from the api-key
 *     cache: there's no "negative-result-is-cheaper-to-be-fast" rule
 *     here, because the question itself is binary and the resolver's
 *     hot path expects identical latency in both directions.
 *
 *   - **No locking around concurrent misses.** Two concurrent misses for
 *     the same key cause two PostgreSQL SELECTs. The cost is small;
 *     avoiding it adds a Promise registry that is easy to leak.
 *
 * The cache implements the same `IsolationLookup` contract from
 * `topic-family.ts` so the resolver does not know whether it is talking
 * to PostgreSQL or the cache.
 *
 * @see docs/architecture/03-redpanda-topics.md "Topic Families"
 * @see docs/architecture/03-redpanda-topics.md "Topic Isolation Triggers"
 * @see docs/implementation/tasks/P11-008-topic-isolation.md
 */

import type { IsolationLookup } from "./topic-family.js";
import type { CanonicalTopicFamily } from "./topics.js";

/**
 * Extended async lookup contract that carries the environment scope.
 *
 * `IsolationLookup` in `topic-family.ts` predates the environment-scoped
 * `topic_isolations` table — its `isIsolated(family, project_id)`
 * signature does not accept an environment because the v1 resolver was
 * single-environment. This module's lookup contract adds the environment
 * scope because the persistent table records isolations per
 * `(family, project_id, environment)`, and a project may be isolated in
 * production but not in development.
 *
 * The class below adapts a {@link ScopedIsolationLookup} into an
 * `IsolationLookup` for a single environment so existing callers can
 * keep using the v1 resolver signature; new callers should consult the
 * cache through {@link TopicIsolationCache.isIsolatedScoped} directly.
 */
export interface ScopedIsolationLookup {
  /**
   * Return whether the given `(family, project_id, environment)` triple
   * is currently isolated (i.e. has an active `topic_isolations` row
   * with `deactivated_at IS NULL`).
   */
  isIsolated(
    family: CanonicalTopicFamily,
    projectId: string,
    environment: string,
  ): Promise<boolean>;
}

/** Options controlling the cache behavior. TTL is wall-clock ms. */
export interface TopicIsolationCacheOptions {
  /** Underlying scoped lookup the cache wraps. */
  readonly reader: ScopedIsolationLookup;
  /** Maximum number of cached entries. Defaults to 1024. */
  readonly maxEntries?: number;
  /** TTL for cached entries (both positive and negative). Defaults to 60_000 ms. */
  readonly ttlMs?: number;
  /** Override `Date.now` for tests. */
  readonly now?: () => number;
}

interface CacheEntry {
  /** The cached boolean. `true` means isolated, `false` means shared. */
  readonly value: boolean;
  /** Absolute expiry timestamp (ms). */
  readonly expiresAt: number;
}

/**
 * Build a deterministic cache key from a triple. The shape is
 * `<family>::<project_id>::<environment>`; the double-colon separator
 * avoids accidental collisions with project ids that happen to contain
 * a colon (the `dedicatedTopicName` helper uses a single dot, so no
 * collision is possible with the family + project_id concatenation
 * either).
 */
function cacheKey(family: CanonicalTopicFamily, projectId: string, environment: string): string {
  return `${family}::${projectId}::${environment}`;
}

/**
 * Wrap a {@link ScopedIsolationLookup} with a TTL+LRU cache. Implements
 * the same `ScopedIsolationLookup` contract so the resolver hot path
 * does not know whether it is talking to PostgreSQL or the cache.
 *
 * Single-environment callers can adapt this cache to the v1
 * `IsolationLookup` contract by calling {@link TopicIsolationCache.forEnvironment}
 * with the environment they operate in.
 */
export class TopicIsolationCache implements ScopedIsolationLookup {
  readonly #reader: ScopedIsolationLookup;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  // Map preserves insertion order; we use that for the LRU bookkeeping
  // by deleting + re-inserting on every read/write so the iterator's
  // first entry is always the LRU candidate.
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: TopicIsolationCacheOptions) {
    this.#reader = options.reader;
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    if (this.#maxEntries < 1) {
      throw new RangeError("TopicIsolationCache.maxEntries must be >= 1");
    }
    if (this.#ttlMs < 0) {
      throw new RangeError("TopicIsolationCache.ttlMs must be >= 0");
    }
  }

  /** Number of entries currently held. Mostly useful for tests. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Drop every cached entry. Operators can call this from a future
   * control-plane hook ("after `polaris topics isolate`, ask each
   * service to invalidate"); the TTL provides a bounded staleness
   * window in the meantime.
   */
  clear(): void {
    this.#entries.clear();
  }

  /**
   * Scoped lookup: returns whether the given triple is currently
   * isolated. Hits the cache when fresh; falls through to the
   * underlying reader on miss or stale entry; caches the result either
   * way.
   */
  async isIsolated(
    family: CanonicalTopicFamily,
    projectId: string,
    environment: string,
  ): Promise<boolean> {
    const key = cacheKey(family, projectId, environment);
    const now = this.#now();
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.expiresAt > now) {
        // LRU bookkeeping: move to most-recently-used position.
        this.#entries.delete(key);
        this.#entries.set(key, existing);
        return existing.value;
      }
      this.#entries.delete(key);
    }
    const value = await this.#reader.isIsolated(family, projectId, environment);
    this.#entries.set(key, { value, expiresAt: now + this.#ttlMs });
    this.#evictIfFull();
    return value;
  }

  /**
   * Adapt this cache to the v1 {@link IsolationLookup} contract by
   * pinning a single environment. Callers that operate in one
   * environment (the ingester runs against one) keep their existing
   * resolver call sites; the environment scope is captured at
   * construction time.
   */
  forEnvironment(environment: string): IsolationLookup {
    const cache = this;
    return {
      async isIsolated(family, projectId): Promise<boolean> {
        return cache.isIsolated(family, projectId, environment);
      },
    };
  }

  #evictIfFull(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

/**
 * In-memory `ScopedIsolationLookup` for tests and bootstrap scenarios.
 * Pre-seed it with `(family, project_id, environment)` triples that
 * should report as isolated.
 */
export class InMemoryScopedIsolationLookup implements ScopedIsolationLookup {
  readonly #isolated = new Set<string>();

  /** Mark a triple as isolated. Subsequent lookups return `true`. */
  add(family: CanonicalTopicFamily, projectId: string, environment: string): void {
    this.#isolated.add(cacheKey(family, projectId, environment));
  }

  /** Remove a triple. Subsequent lookups return `false`. */
  remove(family: CanonicalTopicFamily, projectId: string, environment: string): void {
    this.#isolated.delete(cacheKey(family, projectId, environment));
  }

  async isIsolated(
    family: CanonicalTopicFamily,
    projectId: string,
    environment: string,
  ): Promise<boolean> {
    return this.#isolated.has(cacheKey(family, projectId, environment));
  }
}
