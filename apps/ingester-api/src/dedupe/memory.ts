import type { DedupeClaimInput, DedupeClaimOutcome, DedupeStore } from "./types.js";

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
  private readonly entries = new Map<string, number>();
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
    const key = `${input.projectId}:${input.environment}:${input.eventId}`;
    const now = this.now();
    this.sweep(now);
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > now) {
      return { status: "duplicate" };
    }
    const expiresAt = now + input.ttlSec * 1000;
    this.entries.set(key, expiresAt);
    return { status: "claimed" };
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
    for (const [key, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(key);
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
}
