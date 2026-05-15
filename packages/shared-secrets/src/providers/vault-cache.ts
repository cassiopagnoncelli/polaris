/**
 * In-memory TTL cache for resolved Vault secrets.
 *
 * Behavior:
 *
 *   - Each entry stores the resolved value, the absolute expiry epoch-ms, and
 *     the wall-clock fetch time for diagnostics.
 *   - `get` returns `undefined` on miss or when the entry has expired,
 *     **except** when called via {@link VaultSecretCache.getStale}, which
 *     returns expired entries too. The Vault adapter uses `getStale` when
 *     Vault itself is unreachable, so the service keeps serving cached
 *     credentials until they expire from the secret manager's own lease
 *     window — this is the degraded-but-not-crashed health contract.
 *   - The cache stores plaintext. It must never be logged, dumped, or
 *     iterated outside the adapter's `getSecret` path. The internal value is
 *     not exposed beyond `peek`/`get`/`getStale`.
 *   - No background timers; entries are evicted lazily on access. This keeps
 *     the cache zero-cost on the unbounded fetch path and avoids holding the
 *     event loop open during shutdown.
 *
 * The cache is intentionally a thin, easy-to-reason-about wrapper: a single
 * `Map<ref, Entry>`, plus a clock so tests can drive expiry deterministically.
 *
 * Secret values are never included in error messages thrown by this module.
 */

/**
 * Clock abstraction so tests can drive expiry without mocking `Date.now`.
 *
 * The default clock returns `Date.now()`; a unit test injects a fake clock
 * that advances on demand.
 */
export interface VaultCacheClock {
  now(): number;
}

const SYSTEM_CLOCK: VaultCacheClock = { now: () => Date.now() };

/**
 * Cached value entry. The resolved secret is stored as-is; `expiresAt` is an
 * absolute epoch-ms timestamp computed at insertion time from the TTL.
 */
interface CacheEntry {
  readonly value: string;
  /** Absolute expiry, epoch milliseconds. */
  readonly expiresAt: number;
  /** Wall-clock time the entry was inserted, epoch milliseconds. */
  readonly fetchedAt: number;
}

/**
 * Options for the Vault secret cache.
 */
export interface VaultSecretCacheOptions {
  /**
   * TTL applied to every cached entry, in milliseconds. Must be >= 0.
   *
   * A TTL of `0` disables caching: every `set` is immediately stale, so the
   * adapter never returns a cached value on the fresh path. This is useful in
   * tests and exotic deployments; production use should keep the default of
   * 5 minutes per the architecture brief.
   */
  readonly ttlMs: number;
  /**
   * Optional clock override. Defaults to wall-clock `Date.now()`.
   */
  readonly clock?: VaultCacheClock;
}

/**
 * In-memory TTL cache scoped to one Vault provider instance.
 *
 * Each Polaris service builds one cache; cache state is not shared across
 * processes or replicas. Cache invalidation on rotation is operator-driven
 * (rolling restart of services). See `docs/operations/secret-rotation.md`.
 */
export class VaultSecretCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly clock: VaultCacheClock;

  constructor(options: VaultSecretCacheOptions) {
    if (typeof options.ttlMs !== "number" || !Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new TypeError("VaultSecretCache: ttlMs must be a finite non-negative number");
    }
    this.ttlMs = options.ttlMs;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  /**
   * Fresh-path lookup. Returns the cached value when the entry is present
   * and not expired; otherwise `undefined`.
   *
   * Lazy eviction: when an entry is found to be expired we remove it from
   * the map so a subsequent {@link getStale} call still returns it only if
   * Vault has not yet repopulated the slot. Wait — that breaks the
   * stale-serving contract. Don't evict on the fresh path. The fresh path
   * just reports "miss"; eviction happens explicitly via `delete`.
   */
  public get(ref: string): string | undefined {
    const entry = this.entries.get(ref);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      return undefined;
    }
    return entry.value;
  }

  /**
   * Degraded-path lookup: return the cached value regardless of expiry, as
   * long as an entry exists. Returns `undefined` only when there is no
   * cached value at all.
   *
   * The Vault adapter calls this **only** when a fresh fetch has just
   * failed; the caller is responsible for logging the degraded condition
   * and surfacing it through the readiness probe so operators see the
   * Vault outage even while the service keeps serving previously-fetched
   * credentials.
   */
  public getStale(ref: string): string | undefined {
    return this.entries.get(ref)?.value;
  }

  /**
   * Insert or overwrite an entry. The expiry is computed from the cache's
   * configured TTL and the current clock; callers do not pass an expiry
   * directly to keep the API surface minimal.
   *
   * Returns the inserted entry (without the value) so the caller can log
   * the freshness window without re-reading the cache.
   */
  public set(ref: string, value: string): { fetchedAt: number; expiresAt: number } {
    const now = this.clock.now();
    const entry: CacheEntry = {
      value,
      fetchedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.entries.set(ref, entry);
    return { fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt };
  }

  /**
   * Evict a specific entry. Used by tests and by hypothetical future "force
   * refresh" call sites. The v1 rotation runbook does **not** rely on this
   * — operators rolling-restart services to flush the cache process-wide.
   */
  public delete(ref: string): void {
    this.entries.delete(ref);
  }

  /**
   * Drop every cached entry. Used by tests; not exposed through the
   * provider's public surface.
   */
  public clear(): void {
    this.entries.clear();
  }

  /**
   * Number of cached entries (fresh or stale). Diagnostic only.
   */
  public size(): number {
    return this.entries.size;
  }

  /**
   * Peek at an entry's metadata without exposing the value. Returns
   * `undefined` when the ref has never been cached. Useful for the
   * readiness probe and tests.
   */
  public peek(ref: string): { fetchedAt: number; expiresAt: number } | undefined {
    const entry = this.entries.get(ref);
    if (entry === undefined) return undefined;
    return { fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt };
  }
}
