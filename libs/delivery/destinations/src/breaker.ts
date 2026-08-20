/**
 * Per-instance circuit breaker.
 *
 * A vendor that is down answers every request with a 5xx, and without a
 * breaker the runtime keeps asking. Each ask costs a concurrency slot, an
 * RPS budget entry, a `delivery_records` row and — since the retry ladder
 * landed — a parked message that will come back and ask again. The vendor
 * gets hammered while it is trying to recover, and the consumer spends its
 * whole budget on a destination that cannot accept anything.
 *
 * The breaker's job is not to save the vendor. It is to stop spending the
 * consumer's capacity on a destination that is answering "no" to everything,
 * so the OTHER destinations in the same process keep flowing.
 *
 * ## Three states
 *
 *   closed     normal. Consecutive vendor 5xx are counted.
 *   open       tripped. Deliveries are refused without a network call, until
 *              the cooldown lapses.
 *   half_open  one probe is allowed through. It decides: success closes the
 *              breaker, failure opens it again for another cooldown.
 *
 * Scoped per `(destination_id, environment)`, the same key the rate limiter
 * uses — one instance being down says nothing about another instance of the
 * same vendor pointed at a different account.
 *
 * ## Only consecutive TRANSIENT failures count
 *
 * A 400 means this event was wrong; a 500 means the vendor is wrong. Counting
 * both would let a burst of malformed events from one producer trip a breaker
 * and stop delivery of everything else — turning a data-quality problem into
 * an outage. Any success resets the count to zero, because a breaker that
 * tripped on N failures spread across an hour of healthy traffic would be
 * measuring the wrong thing.
 *
 * ## Deliberately in-memory
 *
 * A shared breaker would let one replica's bad luck stop every replica, and
 * would need consensus about who owns the half-open probe. Per-replica means
 * each one independently discovers the vendor is down, which costs a few
 * extra requests and needs no coordination. This is the opposite call from
 * the rate limiter, and for a reason: `max_rps` is a promise to the vendor
 * that only means something globally, while a breaker is a local decision
 * about how to spend local capacity.
 */

/** Breaker state, as reported to metrics and the CLI. */
export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  /** Consecutive transient failures before tripping. Default 5. */
  readonly failureThreshold?: number;
  /** How long the breaker stays open before probing. Default 30s. */
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export interface BreakerDecision {
  /** `false` when the delivery must not be attempted. */
  readonly allowed: boolean;
  readonly state: BreakerState;
  /** When `allowed` is false, how long until the next probe. */
  readonly retryAfterMs?: number;
}

interface BreakerEntry {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  /** Set while a half-open probe is in flight, so only one is admitted. */
  probing: boolean;
}

export class DestinationCircuitBreaker {
  private readonly entries = new Map<string, BreakerEntry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
    if (this.failureThreshold < 1) {
      throw new RangeError("DestinationCircuitBreaker.failureThreshold must be >= 1");
    }
  }

  /** May this delivery be attempted? */
  check(key: string): BreakerDecision {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.state === "closed") return { allowed: true, state: "closed" };

    const elapsed = this.now() - entry.openedAt;
    if (entry.state === "open") {
      if (elapsed < this.cooldownMs) {
        return { allowed: false, state: "open", retryAfterMs: this.cooldownMs - elapsed };
      }
      // Cooldown lapsed: admit exactly one probe.
      entry.state = "half_open";
      entry.probing = true;
      return { allowed: true, state: "half_open" };
    }

    // half_open. One probe at a time — admitting several would send a burst
    // at a vendor that has just started answering, which is how a recovering
    // service gets knocked over a second time.
    if (entry.probing) {
      return { allowed: false, state: "half_open", retryAfterMs: this.cooldownMs };
    }
    entry.probing = true;
    return { allowed: true, state: "half_open" };
  }

  /** Record a delivery the vendor accepted. */
  onSuccess(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    // A successful probe closes the breaker outright rather than decrementing
    // toward closed: the vendor answered, and counting down would keep
    // refusing traffic from a destination that is demonstrably working.
    this.entries.delete(key);
  }

  /**
   * Record a TRANSIENT failure. Permanent failures must not be passed here —
   * see the module header.
   */
  onFailure(key: string): BreakerState {
    const entry = this.entries.get(key) ?? {
      state: "closed" as BreakerState,
      consecutiveFailures: 0,
      openedAt: 0,
      probing: false,
    };
    this.entries.set(key, entry);

    if (entry.state === "half_open") {
      // The probe failed. Back to open for a full cooldown.
      entry.state = "open";
      entry.openedAt = this.now();
      entry.probing = false;
      return "open";
    }

    entry.consecutiveFailures += 1;
    entry.probing = false;
    if (entry.consecutiveFailures >= this.failureThreshold) {
      entry.state = "open";
      entry.openedAt = this.now();
    }
    return entry.state;
  }

  /** Current state, for metrics and `polaris deliveries`. */
  stateOf(key: string): BreakerState {
    return this.entries.get(key)?.state ?? "closed";
  }

  /** Every instance the breaker currently holds state for. */
  snapshot(): ReadonlyArray<{ key: string; state: BreakerState; consecutiveFailures: number }> {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
    }));
  }

  /** Drop all state. Useful for tests. */
  clear(): void {
    this.entries.clear();
  }
}

/** Breaker key. Same scope as the rate limiter's. */
export function breakerKey(destinationId: string, environment: string): string {
  return `${destinationId}::${environment}`;
}
