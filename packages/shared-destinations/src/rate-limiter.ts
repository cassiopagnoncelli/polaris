/**
 * Per-destination concurrency + RPS limiter.
 *
 * Each destination instance carries operational tuning:
 *
 *   - `max_concurrency`  cap on in-flight deliveries (worker pool size)
 *   - `max_rps`          cap on outbound vendor requests per second
 *
 * The limiter enforces both. `acquire(destinationId, instance)` returns a
 * disposable lease that the caller must `release()` after the delivery
 * attempt finishes (whether the attempt succeeded, failed, or threw).
 *
 * Implementation:
 *
 *   - **Concurrency** is a fair-FIFO semaphore per `(destination_id, env)`.
 *     A caller that exceeds `max_concurrency` waits in a queue until a
 *     lease is released. The queue is unbounded by design — KafkaJS' own
 *     prefetch / partitions-consumed-concurrently is the upstream bound,
 *     so the limiter never sees more pending leases than the consumer
 *     fetched in one round.
 *
 *   - **RPS** is a sliding-window counter per `(destination_id, env)`.
 *     The window is 1 second; the counter holds the timestamps of the
 *     last `max_rps` acquisitions and waits until the oldest timestamp is
 *     out of the window before granting the next lease. The implementation
 *     is intentionally a small ring buffer rather than a token bucket so
 *     the wait calculation is exact.
 *
 * The limiter is single-process. Multi-pod deployments must run the
 * cluster's destination consumers in a topology where each instance has a
 * known fraction of total concurrency (e.g. `max_concurrency / replicas`
 * rounded up). A Redis-backed cluster limiter is future work.
 */

import type { DestinationInstance } from "./db/destination-instance.js";

/**
 * Options accepted by the rate limiter. Tests inject `now()` and `sleep()`
 * to drive deterministic schedules.
 */
export interface DestinationRateLimiterOptions {
  /** Wall-clock source. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Sleep function. Defaults to a `setTimeout`-based promise. Tests pass a
   * promise-returning stub that resolves on a manual tick.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * A lease granted by `acquire`. Holds the start timestamp and the
 * destination id so the runtime can stamp the duration onto the
 * `DestinationMetrics.observeRateLimitWaitMs` gauge.
 */
export interface RateLease {
  readonly destination_id: string;
  /** Wall-clock ms the lease was acquired. */
  readonly acquired_at: number;
  /** How long `acquire` blocked before granting the lease. */
  readonly waited_ms: number;
  /** Release the lease back to the limiter. Idempotent. */
  release(): void;
}

interface PerInstanceState {
  /** Semaphore: number of leases currently outstanding. */
  inFlight: number;
  /** Waiters parked when `inFlight === max_concurrency`. */
  waiters: Array<() => void>;
  /**
   * Sliding-window timestamps (most-recent first). Length never exceeds
   * `max_rps`. The window is 1 second.
   */
  recentAcquisitions: number[];
}

/**
 * Per-(destination_id, environment) concurrency + RPS limiter. One limiter
 * instance owns state for many destinations; the runtime constructs one
 * and reuses it across calls.
 */
export class DestinationRateLimiter {
  private readonly state = new Map<string, PerInstanceState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DestinationRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Acquire a lease for the destination. Resolves when the lease is
   * granted (concurrency + RPS both satisfied). The caller must invoke
   * `release()` on the returned lease — preferably in a `finally`.
   */
  async acquire(instance: DestinationInstance): Promise<RateLease> {
    const key = stateKey(instance);
    const state = this.requireState(key);
    const startedWaiting = this.now();

    // Step 1: concurrency gate.
    if (state.inFlight >= instance.max_concurrency) {
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    }
    state.inFlight += 1;

    // Step 2: RPS gate. We hold the concurrency lease here so the RPS wait
    // does not double-block other callers — they are queued behind us via
    // the semaphore. The release path drains them.
    while (state.recentAcquisitions.length >= instance.max_rps) {
      const oldest = state.recentAcquisitions[state.recentAcquisitions.length - 1];
      if (oldest === undefined) break;
      const now = this.now();
      const waitMs = 1000 - (now - oldest);
      if (waitMs <= 0) {
        state.recentAcquisitions.pop();
        continue;
      }
      await this.sleep(waitMs);
    }

    const acquiredAt = this.now();
    state.recentAcquisitions.unshift(acquiredAt);
    // Trim out-of-window entries opportunistically so the array does not
    // grow unboundedly when `max_rps` is generous.
    pruneOutOfWindow(state.recentAcquisitions, acquiredAt);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      state.inFlight -= 1;
      const next = state.waiters.shift();
      if (next !== undefined) next();
    };

    return {
      destination_id: instance.destination_id,
      acquired_at: acquiredAt,
      waited_ms: acquiredAt - startedWaiting,
      release,
    };
  }

  /** Drop all state. Useful for tests. */
  clear(): void {
    for (const state of this.state.values()) {
      // Release any parked waiters so tests don't hang.
      while (state.waiters.length > 0) {
        const next = state.waiters.shift();
        if (next !== undefined) next();
      }
    }
    this.state.clear();
  }

  /** Current `inFlight` count for a destination (test surface). */
  inFlight(destination_id: string, environment: string): number {
    return this.state.get(`${destination_id}::${environment}`)?.inFlight ?? 0;
  }

  private requireState(key: string): PerInstanceState {
    let state = this.state.get(key);
    if (state === undefined) {
      state = { inFlight: 0, waiters: [], recentAcquisitions: [] };
      this.state.set(key, state);
    }
    return state;
  }
}

function stateKey(instance: DestinationInstance): string {
  return `${instance.destination_id}::${instance.environment}`;
}

function pruneOutOfWindow(timestamps: number[], now: number): void {
  // Walk from the end (oldest entries) and drop anything older than 1s.
  while (timestamps.length > 0) {
    const last = timestamps[timestamps.length - 1];
    if (last === undefined) break;
    if (now - last >= 1000) {
      timestamps.pop();
      continue;
    }
    break;
  }
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
