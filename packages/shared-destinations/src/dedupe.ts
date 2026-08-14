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
 * ## Why `seen` was not enough
 *
 * `seen()` then `mark()` is check-then-act, and across replicas that is a
 * race no shared store can close: two replicas both check (miss), both
 * deliver, both mark. Moving the map into Redis would have shared the
 * WINDOW without removing the double-send — which is the thing the window
 * exists to prevent.
 *
 * So the contract is a CLAIM. `claim()` is atomic (`SET NX PX` in Redis):
 * exactly one caller is told to proceed and every other is told the key is
 * taken. A claim starts short-lived, because a claim that outlived a crashed
 * replica would block the retry that should replace it; `mark()` extends the
 * winner's claim to the full window once the vendor has actually accepted,
 * and `release()` drops it when the delivery failed, so the retry is not
 * refused by its own predecessor.
 *
 * `seen()` remains on the interface for callers that only want to ask, and
 * the ingester's dedupe store uses the same pending/confirmed split for the
 * same reason.
 */

/** Outcome of an atomic claim. */
export type DedupeClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "duplicate"; readonly deliveredAt?: number };

/** Contract for destination-side dedupe. Implementations: in-memory + Redis. */
export interface DestinationDedupe {
  /**
   * Atomically claim a delivery key.
   *
   * `claimed` means this caller — and no other, on any replica — should
   * proceed to deliver. `duplicate` means someone else holds it, and carries
   * the prior delivery's timestamp when the holder had already confirmed.
   *
   * The claim is short-lived until `mark()` extends it. A caller that
   * receives `claimed` and then fails MUST `release()`, or the key stays
   * blocked for the claim TTL.
   */
  claim(destination_id: string, delivery_key: string, nowMs: number): Promise<DedupeClaim>;
  /** Drop a claim whose delivery did not succeed. */
  release(destination_id: string, delivery_key: string): Promise<void>;
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
  /** `undefined` while the entry is a claim nobody has confirmed yet. */
  readonly deliveredAt: number | undefined;
}

/**
 * How long an unconfirmed claim holds the key.
 *
 * Short on purpose. The claim exists to stop two replicas delivering the
 * same event at the same moment, and a claim that outlived a crashed replica
 * would block the retry meant to replace it — the window's job is to prevent
 * a double send, not to make a lost delivery permanent.
 */
const CLAIM_TTL_MS = 60_000;

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

  async claim(destination_id: string, delivery_key: string, nowMs: number): Promise<DedupeClaim> {
    let map = this.perDestination.get(destination_id);
    if (map === undefined) {
      map = new Map();
      this.perDestination.set(destination_id, map);
    }
    const existing = map.get(delivery_key);
    if (existing !== undefined && existing.expiresAt > nowMs) {
      return existing.deliveredAt === undefined
        ? { kind: "duplicate" }
        : { kind: "duplicate", deliveredAt: existing.deliveredAt };
    }
    // Claimed, not delivered: `deliveredAt` stays undefined until `mark`.
    map.set(delivery_key, { expiresAt: nowMs + CLAIM_TTL_MS, deliveredAt: undefined });
    this.evictIfFull(map);
    return { kind: "claimed" };
  }

  async release(destination_id: string, delivery_key: string): Promise<void> {
    const map = this.perDestination.get(destination_id);
    if (map === undefined) return;
    const entry = map.get(delivery_key);
    // Only an UNCONFIRMED claim is releasable. Dropping a confirmed entry
    // would reopen the window on a delivery that really happened.
    if (entry !== undefined && entry.deliveredAt === undefined) map.delete(delivery_key);
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
