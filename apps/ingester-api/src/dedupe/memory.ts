import {
  DEDUPE_STATE_CONFIRMED,
  DEDUPE_STATE_PENDING,
  type DedupeClaimInput,
  type DedupeClaimOutcome,
  type DedupeConfirmInput,
  type DedupeKey,
  type DedupeStore,
} from "./types.js";

/**
 * In-memory dedupe store.
 *
 * Used by tests and as the explicit "Redis is down" fallback when the
 * operator wants soft dedupe even without Redis. Production deployments
 * normally configure the Redis-backed store; this implementation exists
 * so the dedupe contract has a deterministic, dependency-free baseline.
 *
 * The store stores claim keys in a Map keyed by `<projectId>:<environment>:<eventId>`
 * and prunes expired entries lazily on each `claim` call. There is no
 * background timer; the lazy sweep avoids waking the event loop when no
 * traffic is flowing.
 */
export class InMemoryDedupeStore implements DedupeStore {
  private readonly entries = new Map<string, { expiresAt: number; state: string }>();
  private readonly now: () => number;
  private lastSweep = 0;
  private readonly sweepIntervalMs: number;

  constructor(
    options: {
      readonly now?: () => number;
      readonly sweepIntervalMs?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 1_000;
  }

  isHealthy(): boolean {
    return true;
  }

  async claim(input: DedupeClaimInput): Promise<DedupeClaimOutcome> {
    const key = entryKey(input);
    const now = this.now();
    this.sweep(now);
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.expiresAt > now) {
      // A pending lease means the event is not published yet, so the caller
      // must not be told the platform already has it.
      return existing.state === DEDUPE_STATE_CONFIRMED
        ? { status: "duplicate" }
        : { status: "in_progress" };
    }
    this.entries.set(key, {
      expiresAt: now + input.ttlSec * 1000,
      state: DEDUPE_STATE_PENDING,
    });
    return { status: "claimed" };
  }

  async confirm(input: DedupeConfirmInput): Promise<void> {
    const key = entryKey(input);
    // Only extend a lease we still hold: a key that already expired must not
    // be resurrected by a late confirm.
    const existing = this.entries.get(key);
    if (existing === undefined || existing.expiresAt <= this.now()) return;
    this.entries.set(key, {
      expiresAt: this.now() + input.ttlSec * 1000,
      state: DEDUPE_STATE_CONFIRMED,
    });
  }

  async release(input: DedupeKey): Promise<void> {
    this.entries.delete(entryKey(input));
  }

  /** Test-only helper that clears the store. */
  reset(): void {
    this.entries.clear();
    this.lastSweep = 0;
  }

  /** Test-only helper exposing the live entry count. */
  size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

/**
 * Dedupe store that always returns `skipped`. Used as the documented
 * "Redis unavailable, do not dedupe at all" mode. Operators choose this
 * over `InMemoryDedupeStore` when they want each replica to behave the
 * same way as a Redis-down branch — useful when the downstream layer is
 * known-good and the per-replica memory overhead is unwanted.
 */
export class DisabledDedupeStore implements DedupeStore {
  isHealthy(): boolean {
    return true;
  }
  async claim(): Promise<DedupeClaimOutcome> {
    return { status: "skipped", reason: "dedupe_disabled" };
  }
  /** No lease was taken, so there is nothing to promote. */
  async confirm(): Promise<void> {}
  /** No lease was taken, so there is nothing to drop. */
  async release(): Promise<void> {}
}

/**
 * Key shape for the in-memory store. NUL-separated so a value containing the
 * separator cannot make two distinct triples collide.
 */
function entryKey(input: DedupeKey): string {
  return `${input.projectId}\u0000${input.environment}\u0000${input.eventId}`;
}
