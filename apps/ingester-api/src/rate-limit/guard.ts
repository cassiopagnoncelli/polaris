/**
 * Rate-limit Fastify preHandler.
 *
 * Mirrors `../origin/guard.ts`:
 *
 *   - runs AFTER `authPreHandler` so `request.auth` is populated,
 *   - runs BEFORE the origin guard — a request refused on volume should
 *     not consume an allow-list lookup,
 *   - calls `rateLimiter.acquire({ apiKeyId, projectId, environment })`,
 *   - on `allowed: false`, increments
 *     `polaris_ingest_rate_limit_rejected_total`, sets the standard
 *     `Retry-After: <seconds>` header on the response, and throws
 *     `ProblemError({ status: 429, code: 'rate_limited' })`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { ProblemError } from "@polaris/shared-service-bootstrap";

import type { IngestMetrics } from "../metrics/registry.js";

import type { RateLimiter } from "./types.js";

/** Stable Problem code emitted when a request is refused on volume. */
export const RATE_LIMITED_CODE = "rate_limited" as const;

export interface RateLimitGuardDeps {
  readonly limiter: RateLimiter;
  readonly metrics: IngestMetrics;
}

/**
 * Build the rate-limit `preHandler` hook.
 *
 * The hook expects `request.auth` to be populated, so it MUST run after
 * the auth pre-handler.
 */
export function createRateLimitPreHandler(deps: RateLimitGuardDeps) {
  const { limiter, metrics } = deps;

  return async function rateLimitPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const auth = request.auth;
    if (auth === undefined) {
      // Defensive: mirrors the origin guard posture. Treat as a wiring bug.
      throw new ProblemError({
        status: 500,
        code: "internal_error",
        title: "Internal error",
        detail: "Rate-limit guard reached without an authenticated context.",
      });
    }

    const decision = await limiter.acquire({
      apiKeyId: auth.apiKeyId,
      projectId: auth.projectId,
      environment: auth.environment,
    });
    if (decision.allowed) return;

    metrics.incrementRateLimitRejected({
      project_id: auth.projectId,
      environment: auth.environment,
    });
    // `Retry-After` MUST be set on the response — RFC 6585 §4 requires
    // it on a 429 and SDKs read it to compute their backoff.
    reply.header("retry-after", String(decision.retry_after_seconds));
    throw new ProblemError({
      status: 429,
      code: RATE_LIMITED_CODE,
      title: "Too many requests",
      detail: `Per-key rate limit exceeded. Retry after ${decision.retry_after_seconds}s.`,
    });
  };
}
