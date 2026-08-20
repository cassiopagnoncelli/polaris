/**
 * `destinations.retry_policy` → a backoff schedule.
 *
 * The column has been written since destinations shipped, is returned by
 * `polaris destinations show`, and until now was read by nothing: every
 * instance backed off identically no matter what an operator set. That is
 * the same defect class as `processor_activations` and
 * `partitions_consumed_concurrently` — a knob that turns and moves nothing.
 *
 * ## Policies select tiers, they do not invent delays
 *
 * The retry tiers are QUEUES, declared by `pnpm rabbitmq:provision` from
 * `RETRY_BACKOFF_TIERS_MS`, and the broker owns the delay through each
 * queue's message TTL. A policy that computed an arbitrary backoff would
 * have to publish to a queue nobody declared, so what a policy chooses is
 * WHICH of the five provisioned tiers a given attempt lands in.
 *
 * That constraint is worth stating because it is easy to read these tables
 * as "aggressive retries after 5s" and expect a knob that does not exist.
 * The tiers are fixed; the walk across them is the policy.
 *
 *   tiers:  0 = 5s   1 = 30s   2 = 2m   3 = 10m   4 = 30m
 *
 *   attempt        1     2     3     4     5    6+
 *   standard       5s    30s   2m    10m   30m  30m
 *   aggressive     5s    5s    30s   30s   2m   2m
 *   conservative   30s   2m    10m   30m   30m  30m
 *
 * `standard` reproduces the previous hardcoded behaviour exactly, so an
 * instance that never set the column sees no change at the moment this
 * starts being read — which matters, because until this card the retry
 * ladder was not wired at all and every operator's setting is therefore
 * untested in production.
 *
 * `aggressive` suits a vendor whose 5xx are usually momentary: four attempts
 * inside a minute rather than spread over two and a half. `conservative`
 * suits a vendor that rate-limits by shedding load, where retrying quickly
 * is what keeps it shedding.
 */

import type { DestinationRetryPolicy } from "@polaris/persistence-postgres";
import { RETRY_BACKOFF_TIERS_MS } from "@polaris/bus";

// `DestinationRetryPolicy` comes from `@polaris/persistence-postgres`, which mirrors the
// `destinations_retry_policy_allowed` CHECK constraint. Redeclaring the union
// here would be a second copy of a closed set the database already owns, and
// the two would drift the first time a policy was added.

/**
 * Tier INDEX per 1-based attempt. The last entry repeats for any attempt
 * beyond the table, which is what makes an unbounded attempt count safe —
 * `dead_letter_threshold` is what stops the walk, not the table's length.
 */
const POLICY_TIER_INDEX: Readonly<Record<DestinationRetryPolicy, readonly number[]>> =
  Object.freeze({
    standard: [0, 1, 2, 3, 4],
    aggressive: [0, 0, 1, 1, 2],
    conservative: [1, 2, 3, 4, 4],
  });

/**
 * Backoff in milliseconds for one attempt under one policy.
 *
 * Returns a value from `RETRY_BACKOFF_TIERS_MS` and nothing else, so the
 * result is always a queue that exists. An unrecognised policy — a row
 * written by a newer build, or one hand-edited past the CHECK constraint —
 * falls back to `standard` rather than throwing: a delivery must not fail
 * because its backoff table is unfamiliar.
 */
export function retryDelayMsFor(policy: string, attempt: number): number {
  const table = POLICY_TIER_INDEX[policy as DestinationRetryPolicy] ?? POLICY_TIER_INDEX.standard;
  const clamped = Math.min(Math.max(Math.trunc(attempt), 1), table.length);
  const tierIndex = table[clamped - 1] ?? 0;
  const tier = RETRY_BACKOFF_TIERS_MS[tierIndex];
  // Unreachable while the tables above index within RETRY_BACKOFF_TIERS_MS;
  // the fallback keeps a mis-edit from throwing inside a delivery.
  return tier ?? RETRY_BACKOFF_TIERS_MS[0];
}
