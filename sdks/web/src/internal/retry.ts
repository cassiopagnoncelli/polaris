/**
 * Retry policy with exponential backoff and jitter for the Web SDK.
 *
 * Per `docs/architecture/10-sdk-standards.md` § Retry Behavior:
 *
 *   - Preserve original `event_id` across retries.
 *   - Retry transient request failures with exponential backoff and jitter.
 *   - Do not retry permanent validation failures.
 *   - Respect per-event batch response outcomes.
 *
 * Defaults from the same doc:
 *
 *   max_retries: 3
 *   retry_backoff: exponential with jitter
 *
 * Backoff schedule (1-indexed `attempt`):
 *
 *   attempt 1 -> initialDelayMs * multiplier^0 + jitter
 *   attempt 2 -> initialDelayMs * multiplier^1 + jitter
 *   ...
 *   clamped to [0, maxDelayMs].
 *
 * This is intentionally near-identical to the Node SDK retry helper — the
 * Web SDK keeps its own copy to avoid a runtime dep on `@polaris/node-sdk`
 * (browser bundles must not pull Node.js code).
 */

import type { RetryPolicy } from "../types.js";

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
};

/** Merge a partial retry policy with defaults. */
export function resolveRetryPolicy(partial: Partial<RetryPolicy> | undefined): RetryPolicy {
  if (!partial) return DEFAULT_RETRY_POLICY;
  return {
    maxRetries: partial.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
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
 * Jitter is bidirectional (+/- `jitterRatio * base`) so retries spread on
 * both sides of the deterministic schedule rather than always clustering on
 * the upper side. The total is clamped to `[0, maxDelayMs]`.
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
 * tested without real timers.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
