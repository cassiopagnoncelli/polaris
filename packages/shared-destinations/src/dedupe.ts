/**
 * In-memory destination-side dedupe window.
 *
 * Per `docs/architecture/06-destinations.md` "Delivery Model":
 *
 *   - Consumers are idempotent before sending whenever possible.
 *   - Consumers generate stable destination delivery keys.
 *
 * The ingester already runs a 15-minute event-id dedupe window as a
 * retry-storm absorber, but its window does not cover replay traffic and
 * does not see destination-instance scope. The destination runtime needs
 * its own window so:
 *
 *   - A replay job that re-runs the same envelope through the same
 *     destination instance does not produce double-delivery if the
 *     window is still open.
 *   - A KafkaJS retry that lands on a different partition cooperator
 *     still observes the dedupe even if the broker re-delivered the
 *     message.
 *
 * The window is short by default (15 minutes, matching the ingester's
 * window) and operator-tunable. Anything longer than the window relies on
 * vendor-side dedupe (Meta `event_id`, GA4 `transaction_id`) which the
 * runtime forwards through `dedupe_key`.
 *
 * Implementation: a per-destination map of `delivery_key -> expiresAt`.
 * The runtime calls `seen(key)` BEFORE delivering and `mark(key)` AFTER a
 * successful delivery. A `seen(key) === true` event is recorded as a
 * skip + structured log line; the underlying message is NOT re-delivered.
 *
 * The in-memory dedupe is single-process. A Redis-backed cluster dedupe
 * is future work; the runtime's interface (`DestinationDedupe`) lets the
 * Redis adapter slot in without touching call sites.
 */

/** Contract for destination-side dedupe. Implementations: in-memory + future Redis. */
export interface DestinationDedupe {
  /**
   * Has this delivery key already been delivered within the window?
   * Returns the prior delivery's wall-clock timestamp (ms) when the key
   * is known, or `undefined` when it is fresh.
   */
  seen(destination_id: string, delivery_key: string): Promise<number | undefined>;
  /**
   * Mark a delivery key as delivered. The runtime calls this AFTER a
   * successful deliverer call. Subsequent `seen()` checks within the
   * window return the stamped timestamp.
   */
  mark(destination_id: string, delivery_key: string, deliveredAt: number): Promise<void>;
}

/**
 * Options accepted by the in-memory adapter.
 *
 *   - `windowMs`     dedupe window in wall-clock ms. Default 15 * 60_000
 *                    (15 minutes), matching the ingester's
 *                    `event_id_dedupe_window_seconds_default`.
 *   - `maxEntries`   per-destination cap on tracked keys. Default 65_536.
 *   - `now`          wall-clock source for tests.
 */
export interface InMemoryDestinationDedupeOptions {
  readonly windowMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface DedupeEntry {
  readonly expiresAt: number;
  readonly deliveredAt: number;
}

/**
 * In-memory `DestinationDedupe`. Single-process. Suitable for unit tests,
 * single-replica deployments, and the smoke harness.
 *
 * Eviction is lazy: expired entries are removed on the next lookup that
 * touches them, plus an opportunistic sweep when the per-destination map
 * exceeds `maxEntries`.
 */
export class InMemoryDestinationDedupe implements DestinationDedupe {
  private readonly perDestination = new Map<string, Map<string, DedupeEntry>>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: InMemoryDestinationDedupeOptions = {}) {
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.maxEntries = options.maxEntries ?? 65_536;
    this.now = options.now ?? Date.now;
    if (this.windowMs < 0) {
      throw new RangeError("InMemoryDestinationDedupe.windowMs must be >= 0");
    }
    if (this.maxEntries < 1) {
      throw new RangeError("InMemoryDestinationDedupe.maxEntries must be >= 1");
    }
  }

  async seen(destination_id: string, delivery_key: string): Promise<number | undefined> {
    const map = this.perDestination.get(destination_id);
    if (map === undefined) return undefined;
    const entry = map.get(delivery_key);
    if (entry === undefined) return undefined;
    const now = this.now();
    if (entry.expiresAt <= now) {
      map.delete(delivery_key);
      return undefined;
    }
    return entry.deliveredAt;
  }

  async mark(destination_id: string, delivery_key: string, deliveredAt: number): Promise<void> {
    let map = this.perDestination.get(destination_id);
    if (map === undefined) {
      map = new Map();
      this.perDestination.set(destination_id, map);
    }
    map.set(delivery_key, {
      expiresAt: deliveredAt + this.windowMs,
      deliveredAt,
    });
    this.evictIfFull(map);
  }

  /** Drop all dedupe state. Useful for tests. */
  clear(): void {
    this.perDestination.clear();
  }

  /** Size of one destination's window. Useful for tests. */
  windowSize(destination_id: string): number {
    return this.perDestination.get(destination_id)?.size ?? 0;
  }

  private evictIfFull(map: Map<string, DedupeEntry>): void {
    if (map.size <= this.maxEntries) return;
    // Iteration order of `Map` is insertion order; drop the oldest entries
    // first.
    const overflow = map.size - this.maxEntries;
    let removed = 0;
    for (const key of map.keys()) {
      if (removed >= overflow) break;
      map.delete(key);
      removed += 1;
    }
  }
}
