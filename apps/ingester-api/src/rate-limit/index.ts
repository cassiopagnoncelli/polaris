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
  readonly projectOverrides?: ReadonlyMap<string, number>;
}): RateLimitAllowanceResolver {
  const { defaultPerKeyRps, projectOverrides } = input;
  if (projectOverrides === undefined || projectOverrides.size === 0) {
    return () => defaultPerKeyRps;
  }
  return (acquire: RateLimitAcquireInput) => {
    const override = projectOverrides.get(acquire.projectId);
    return override ?? defaultPerKeyRps;
  };
}
