/**
 * Destination instance reader (with a small TTL+LRU cache).
 *
 * The runtime reads `destinations` rows on every event so the host's runtime
 * tuning (status, mode, max_concurrency, max_rps, retry_policy,
 * dead_letter_threshold) is honored without restart. Without a cache, the
 * round trip to PostgreSQL dominates the latency profile under steady load.
 *
 * The cache mirrors the api-key cache pattern from `apps/ingester-api/src/
 * auth/cache.ts`:
 *
 *   - **TTL.** Entries expire after a wall-clock duration. Default 60s,
 *     matching the api-key cache. A `polaris destinations disable` operation
 *     becomes live within at most one TTL window. Operators with a strict
 *     SLA can lower the TTL or call `cache.clear()` from a control-plane
 *     hook (future P10-x work).
 *
 *   - **LRU eviction.** Bounded memory matters even though `destination_id`
 *     is operator-controlled — a runaway list query could otherwise blow
 *     the cache.
 *
 *   - **Negative results.** A `null` lookup (no such destination) is cached
 *     for a shorter window so probe traffic doesn't hammer PostgreSQL.
 *
 *   - **No locking around concurrent misses.** Same trade-off as the api-key
 *     cache: two concurrent misses are cheap; a Promise registry is easy
 *     to leak.
 *
 * The reader exposes a `DestinationInstanceReader` contract so tests can
 * inject in-memory adapters and production wires the Kysely adapter.
 *
 * Resolved secret values do NOT live in this module. The reader returns the
 * `secret_ref` literal (`provider:ref` form); the runtime resolves it
 * through `@polaris/shared-secrets` per delivery attempt, in memory only.
 */

import type {
  Database,
  DestinationMode,
  DestinationRetryPolicy,
  DestinationStatus,
} from "@polaris/shared-db";
import type { Kysely } from "kysely";

/**
 * Subset of the `destinations` row the runtime needs at every delivery
 * attempt. The runtime never reads anything outside this shape; the shape
 * is intentionally narrow so the cache footprint stays small.
 *
 * `secret_ref` is the `provider:ref` literal stored in PostgreSQL. The
 * runtime hands it to `@polaris/shared-secrets`'s `SecretResolver`; the
 * resolved plaintext lives in memory only for the duration of one
 * delivery attempt.
 *
 * `replay_opt_in` (P7-004) is the per-instance gate the runtime consults
 * before delivering replay traffic. It DEFAULTS to `false` for every row;
 * operators flip it on via `polaris destinations enable-replay <id>
 * --reason <text>`. The runtime's per-message check in
 * `replay-suppression.ts` consults this flag alongside the host-level
 * `allowReplay` opt-in — both must be true for a replay message to
 * advance past the suppression gate.
 */
export interface DestinationInstance {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly secret_ref: string;
  readonly status: DestinationStatus;
  readonly mode: DestinationMode;
  readonly max_concurrency: number;
  readonly max_rps: number;
  readonly retry_policy: DestinationRetryPolicy;
  readonly dead_letter_threshold: number;
  /**
   * Per-instance replay opt-in. P7-004 ships the column; the runtime
   * defaults to suppressing replay traffic when the column is `false`
   * (which is also the schema default for every newly-created
   * destination).
   */
  readonly replay_opt_in: boolean;
}

/**
 * Contract for reading destination instances. Production wires the Kysely
 * adapter; tests use the in-memory adapter.
 *
 * The contract is intentionally narrow: one `findById` and one `findActive`
 * (to seed the subscribe loop's per-vendor list). Operational write
 * commands (`polaris destinations create`, `enable`, `disable`, ...) live
 * in the CLI and write through `@polaris/shared-db` directly — they do not
 * go through this reader.
 */
export interface DestinationInstanceReader {
  /** Read one instance by id. Returns `null` when not found. */
  findById(destination_id: string): Promise<DestinationInstance | null>;
  /**
   * List active instances for a (vendor, environment) pair. Used by the
   * runtime's subscribe loop on boot when the host has not pre-supplied a
   * list of destination ids.
   */
  findActiveByVendor(vendor: string, environment: string): Promise<readonly DestinationInstance[]>;
}

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

/**
 * Pure in-memory `DestinationInstanceReader`. The store is operator-seeded
 * via `set`; tests preload it before invoking the runtime.
 */
export class InMemoryDestinationInstanceReader implements DestinationInstanceReader {
  private readonly byId = new Map<string, DestinationInstance>();

  /** Replace or insert one instance. */
  set(instance: DestinationInstance): void {
    this.byId.set(instance.destination_id, instance);
  }

  /** Remove one instance (e.g. simulate a destination disable). */
  remove(destination_id: string): void {
    this.byId.delete(destination_id);
  }

  async findById(destination_id: string): Promise<DestinationInstance | null> {
    return this.byId.get(destination_id) ?? null;
  }

  async findActiveByVendor(
    vendor: string,
    environment: string,
  ): Promise<readonly DestinationInstance[]> {
    const matches: DestinationInstance[] = [];
    for (const instance of this.byId.values()) {
      if (
        instance.vendor === vendor &&
        instance.environment === environment &&
        instance.status === "active"
      ) {
        matches.push(instance);
      }
    }
    return matches;
  }
}

// ---------------------------------------------------------------------------
// Kysely-backed adapter
// ---------------------------------------------------------------------------

/** Options accepted by the SQL-backed adapter. */
export interface KyselyDestinationInstanceReaderOptions {
  readonly db: Kysely<Database>;
}

/**
 * Build a Kysely-backed `DestinationInstanceReader`. Reads only the columns
 * the runtime needs; ignores `disabled_reason` / `created_at` / `updated_at`
 * because the runtime never reads them.
 */
export function createKyselyDestinationInstanceReader(
  options: KyselyDestinationInstanceReaderOptions,
): DestinationInstanceReader {
  const { db } = options;
  async function findById(destination_id: string): Promise<DestinationInstance | null> {
    const row = await db
      .selectFrom("destinations")
      .select([
        "destination_id",
        "project_id",
        "environment",
        "vendor",
        "instance_label",
        "secret_ref",
        "status",
        "mode",
        "max_concurrency",
        "max_rps",
        "retry_policy",
        "dead_letter_threshold",
        "replay_opt_in",
      ])
      .where("destination_id", "=", destination_id)
      .executeTakeFirst();
    return row === undefined ? null : (row as DestinationInstance);
  }

  async function findActiveByVendor(
    vendor: string,
    environment: string,
  ): Promise<readonly DestinationInstance[]> {
    const rows = await db
      .selectFrom("destinations")
      .select([
        "destination_id",
        "project_id",
        "environment",
        "vendor",
        "instance_label",
        "secret_ref",
        "status",
        "mode",
        "max_concurrency",
        "max_rps",
        "retry_policy",
        "dead_letter_threshold",
        "replay_opt_in",
      ])
      .where("vendor", "=", vendor)
      .where("environment", "=", environment)
      .where("status", "=", "active")
      .execute();
    return rows as readonly DestinationInstance[];
  }

  return { findById, findActiveByVendor };
}

// ---------------------------------------------------------------------------
// TTL + LRU cache
// ---------------------------------------------------------------------------

/** Options controlling the cache behavior. Both TTLs are wall-clock ms. */
export interface DestinationInstanceCacheOptions {
  readonly reader: DestinationInstanceReader;
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
  readonly instance: DestinationInstance | null;
  readonly expiresAt: number;
}

/**
 * Wraps a `DestinationInstanceReader` with a TTL+LRU cache. Implements the
 * same `findById` contract so the runtime does not know whether it is
 * talking to PostgreSQL or the cache.
 *
 * `findActiveByVendor` is intentionally **not** cached: the runtime calls
 * it once at boot (to seed the per-vendor list), not on every event. A
 * stale list there would cause new instances to be missed until restart;
 * `findById` is the per-event path that benefits from caching.
 */
export class DestinationInstanceCache implements DestinationInstanceReader {
  readonly #reader: DestinationInstanceReader;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #negativeTtlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: DestinationInstanceCacheOptions) {
    this.#reader = options.reader;
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#negativeTtlMs = options.negativeTtlMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    if (this.#maxEntries < 1) {
      throw new RangeError("DestinationInstanceCache.maxEntries must be >= 1");
    }
    if (this.#ttlMs < 0 || this.#negativeTtlMs < 0) {
      throw new RangeError("DestinationInstanceCache TTLs must be >= 0");
    }
  }

  /** Number of entries currently held. Mostly useful for tests. */
  get size(): number {
    return this.#entries.size;
  }

  /** Drop every cached entry. */
  clear(): void {
    this.#entries.clear();
  }

  async findById(destination_id: string): Promise<DestinationInstance | null> {
    const now = this.#now();
    const existing = this.#entries.get(destination_id);
    if (existing !== undefined) {
      if (existing.expiresAt > now) {
        // LRU bookkeeping: move to most-recently-used position.
        this.#entries.delete(destination_id);
        this.#entries.set(destination_id, existing);
        return existing.instance;
      }
      this.#entries.delete(destination_id);
    }
    const instance = await this.#reader.findById(destination_id);
    const ttl = instance === null ? this.#negativeTtlMs : this.#ttlMs;
    this.#entries.set(destination_id, { instance, expiresAt: now + ttl });
    this.#evictIfFull();
    return instance;
  }

  async findActiveByVendor(
    vendor: string,
    environment: string,
  ): Promise<readonly DestinationInstance[]> {
    return this.#reader.findActiveByVendor(vendor, environment);
  }

  #evictIfFull(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
