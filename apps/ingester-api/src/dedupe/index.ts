/**
 * Public surface of the ingester dedupe layer.
 *
 * The dedupe step is a retry-storm absorber, not the canonical idempotency
 * layer. Downstream consumers remain authoritatively idempotent on their
 * own; this layer shrinks the duplicate count under retry storms.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md "Deduplication"
 */

export { DisabledDedupeStore, InMemoryDedupeStore } from "./memory.js";
export {
  buildDedupeKey,
  buildRedisOptions,
  type CreateRedisDedupeStoreOptions,
  createRedisDedupeStore,
  type RedisClientLike,
} from "./redis.js";
export type { DedupeClaimInput, DedupeClaimOutcome, DedupeStore } from "./types.js";
