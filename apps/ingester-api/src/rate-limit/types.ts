/**
 * Rate-limit module types.
 *
 * Per `docs/architecture/11-production-readiness.md` "Security Hardening",
 * the ingester applies a sliding-window rate limit keyed on
 * `api_key_id` so a single noisy SDK can't drown the broker. The contract
 * mirrors the dedupe store posture: the limiter fails OPEN on Redis
 * outages (return `allowed: true`, emit
 * `polaris_ingest_rate_limit_skipped_total`) — Polaris prefers letting a
 * burst through to refusing legitimate traffic when the limiter
 * subsystem is degraded.
 */

/**
 * Outcome of a single `acquire` call.
 *
 * `allowed: false` carries a `retry_after_seconds` integer the guard
 * surfaces via the standard `Retry-After` HTTP header so SDKs back off
 * for the right window.
 */
export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retry_after_seconds: number };

/**
 * Per-request input to `acquire`. Limits are keyed on `apiKeyId` so two
 * keys for the same project don't share a bucket; `projectId` +
 * `environment` ride along for metric labelling.
 */
export interface RateLimitAcquireInput {
  readonly apiKeyId: string;
  readonly projectId: string;
  readonly environment: string;
}

/**
 * Rate-limiter contract. Production wires the Redis-backed adapter;
 * tests use the in-memory adapter. Both share the same surface so the
 * Fastify guard never branches.
 */
export interface RateLimiter {
  /** Acquire one token. Returns the decision; never throws on infra error. */
  acquire(input: RateLimitAcquireInput): Promise<RateLimitDecision>;
}
