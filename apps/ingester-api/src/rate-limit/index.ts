/**
 * Rate-limit module barrel.
 *
 * Re-exports the adapter constructors, the guard preHandler factory, and
 * a tiny `createAllowanceResolver` helper that combines the per-key
 * default + per-project override map into a single resolver the
 * adapters consume.
 */

export {
  createRateLimitPreHandler,
  RATE_LIMITED_CODE,
  type RateLimitGuardDeps,
} from "./guard.js";
export {
  type CreateMemoryRateLimiterOptions,
  createMemoryRateLimiter,
} from "./memory.js";
export {
  type CreateRedisRateLimiterOptions,
  createRedisRateLimiter,
  DEFAULT_RATE_LIMIT_KEY_PREFIX,
  DEFAULT_RATE_LIMIT_OP_TIMEOUT_MS,
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitAllowanceResolver,
  type RateLimitRedisClient,
} from "./redis.js";

export type {
  RateLimitAcquireInput,
  RateLimitDecision,
  RateLimiter,
} from "./types.js";

import type { PolarisEnvironment } from "@polaris/shared-environments";
import type { RateLimitAllowanceResolver } from "./redis.js";
import type { RateLimitAcquireInput } from "./types.js";

/**
 * Build a `RateLimitAllowanceResolver` from a default per-key RPS and an
 * optional per-project override map. `projectOverrides` keys are
 * `project_id`; the resolver picks the override when present, otherwise
 * the default.
 */
export function createAllowanceResolver(input: {
  readonly defaultPerKeyRps: number;
  /**
   * Per-project budget, read from the project-config cache. Synchronous: the
   * limiter runs on every request, so this must never perform I/O — see
   * ../project-config-lookup.ts.
   */
  readonly resolveProjectRps?: (projectId: string, environment: PolarisEnvironment) => number;
}): RateLimitAllowanceResolver {
  const { defaultPerKeyRps, resolveProjectRps } = input;
  if (resolveProjectRps === undefined) {
    return () => defaultPerKeyRps;
  }
  return (acquire: RateLimitAcquireInput) =>
    resolveProjectRps(acquire.projectId, acquire.environment as PolarisEnvironment);
}
