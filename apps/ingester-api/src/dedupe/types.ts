/**
 * Dedupe layer surface.
 *
 * The ingester's dedupe step is a **retry-storm absorber**, not the canonical
 * idempotency layer. Downstream consumers (processors, destination consumers,
 * ClickHouse) remain authoritatively idempotent on their own — this layer
 * shrinks the duplicate count when SDK reconnects or producer outbox replays
 * flood the API, but it does not promise uniqueness.
 *
 * The contract is deliberately narrow: one method, `claim`, that returns
 * whether a `(project_id, environment, event_id)` triple is the first
 * observation inside the configured window. Implementations:
 *
 *   - Redis (`createRedisDedupeStore`): primary; uses `SET NX EX` per claim.
 *   - In-memory (`InMemoryDedupeStore`): used by tests and as the documented
 *     fallback when Redis is unavailable. The fallback is **not** a hidden
 *     state — Redis-down paths log a warning and either skip dedupe entirely
 *     or use the in-process store; both are explicit operational choices.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md "Deduplication"
 */

/** Outcome of a single dedupe claim attempt. */
export type DedupeClaimOutcome =
  /** This is the first observation inside the window. Caller publishes the event. */
  | { readonly status: "claimed" }
  /** A claim for the same key already exists. Caller rejects the event with `duplicate`. */
  | { readonly status: "duplicate" }
  /**
   * The dedupe store is unavailable (Redis down, timeout, network error).
   * Per the docs, ingestion continues without dedupe — the caller treats
   * this exactly like a `claimed` outcome but records the skip in metrics
   * so operators can detect a Redis outage from the metric alone.
   */
  | { readonly status: "skipped"; readonly reason: string };

/**
 * Input accepted by the dedupe store. The store composes a Redis key from
 * these fields plus the configured key prefix.
 */
export interface DedupeClaimInput {
  readonly projectId: string;
  readonly environment: string;
  readonly eventId: string;
  /** TTL of the dedupe entry in seconds. Resolved by the orchestrator. */
  readonly ttlSec: number;
}

/**
 * Dedupe store contract used by the ingester handler. Implementations must
 * be safe to call from many concurrent requests and must not throw on
 * transient errors — they return `skipped` instead.
 */
export interface DedupeStore {
  claim(input: DedupeClaimInput): Promise<DedupeClaimOutcome>;
  /**
   * True when the underlying backend is currently considered usable. Used
   * by `/ready` and by Prometheus metrics. The default Redis implementation
   * tracks `connect`/`error` events; the in-memory implementation always
   * returns `true`.
   */
  isHealthy(): boolean;
  /**
   * Optional close hook for graceful shutdown. The Fastify app composes
   * `dedupe.close()` into its shutdown task list when present.
   */
  close?(): Promise<void>;
}
