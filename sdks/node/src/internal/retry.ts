/**
 * Retry policy with exponential backoff and jitter.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   - Preserve original `event_id` across retries.
 *   - Retry transient request failures with exponential backoff and jitter.
 *   - Do not retry permanent validation failures.
 *
 * Backoff schedule:
 *
 *   attempt 1 → initialDelayMs * multiplier^0 + jitter
 *   attempt 2 → initialDelayMs * multiplier^1 + jitter
 *   ...
 *   capped at maxDelayMs.
 *
 * Jitter is computed as a fraction of the deterministic delay so retries
 * spread out under retry-storm conditions (per the 15-minute ingress
 * dedupe described in `04-ingestion-and-sdks.md`).
 */

import type { RetryPolicy } from "../types.js";

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
};

/** Merge a partial retry policy with defaults. */
export function resolveRetryPolicy(partial: Partial<RetryPolicy> | undefined): RetryPolicy {
  if (!partial) return DEFAULT_RETRY_POLICY;
  return {
    maxAttempts: partial.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    initialDelayMs: partial.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs,
    maxDelayMs: partial.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    backoffMultiplier: partial.backoffMultiplier ?? DEFAULT_RETRY_POLICY.backoffMultiplier,
    jitterRatio: partial.jitterRatio ?? DEFAULT_RETRY_POLICY.jitterRatio,
  };
}

/**
 * Compute the delay before `attempt` (1-indexed). `randomFn` is injectable
 * so tests can pin jitter deterministically.
 *
 * Jitter is bidirectional (`+/- jitterRatio * base`) so retries spread on
 * both sides of the deterministic schedule rather than always clustering on
 * the upper side. The total result is clamped to `[0, maxDelayMs]`.
 */
export function computeBackoffMs(
  policy: RetryPolicy,
  attempt: number,
  randomFn: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, attempt);
  const base = policy.initialDelayMs * policy.backoffMultiplier ** (safeAttempt - 1);
  const capped = Math.min(base, policy.maxDelayMs);
  const jitterMagnitude = capped * policy.jitterRatio;
  const jitter = jitterMagnitude * (randomFn() * 2 - 1);
  const total = capped + jitter;
  if (total < 0) return 0;
  if (total > policy.maxDelayMs) return policy.maxDelayMs;
  return total;
}

/**
 * `setTimeout`-based sleep. Exposed as a function so the SDK core can be
 * tested without real timers (the SDK injects a fake `sleep` in tests).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Best-effort: do not keep the event loop alive just to honor the
    // retry sleep. Node's `Timeout.unref()` is the well-known pattern.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  });
}
