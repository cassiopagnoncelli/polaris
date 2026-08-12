/**
 * Dedupe layer surface.
 *
 * The ingester's dedupe step is a **retry-storm absorber**, not the canonical
 * idempotency layer. Downstream consumers (processors, destination consumers,
 * ClickHouse) remain authoritatively idempotent on their own — this layer
 * shrinks the duplicate count when SDK reconnects or producer outbox replays
 * flood the API, but it does not promise uniqueness.
 *
 * ## Why a claim is a lease, not a record
 *
 * The window entry is written BEFORE the event is published, because its job
 * is to stop the second copy of a retry storm from reaching the broker at
 * all. That ordering is what makes the layer worth having — and it is also
 * how a naive implementation destroys events:
 *
 *   claim -> publish fails -> caller told "retry the event"
 *         -> retry hits the surviving claim -> `duplicate` -> event gone.
 *
 * The client did exactly what it was told and the event no longer exists
 * anywhere. That was the only at-most-once path in a platform that is
 * otherwise at-least-once end to end, and it fired on any broker blip.
 *
 * So a claim is a **lease** held for {@link DEDUPE_LEASE_TTL_SEC} while the
 * publish is in flight, and the caller must close it:
 *
 *   - `confirm` promotes the lease to the full dedupe window (event durable)
 *   - `release` drops it (publish failed, the caller's retry must succeed)
 *
 * A process that dies mid-publish closes neither, and the lease expires on
 * its own — so the blast radius of a crash is bounded by the lease, not by
 * the 15-minute window.
 *
 * ## Failure posture
 *
 * No method throws. Redis being down is an operational condition, not an
 * event-rejection condition: `claim` returns `skipped`, and `confirm` /
 * `release` swallow and log. `confirm` failing costs a duplicate later;
 * `release` failing costs a rejected retry until the lease expires. Both
 * degrade; neither loses an event permanently.
 *
 * Implementations:
 *
 *   - Redis (`createRedisDedupeStore`): primary; uses `SET NX EX` per claim.
 *   - In-memory (`InMemoryDedupeStore`): used by tests and as the documented
 *     fallback when Redis is unavailable. The fallback is **not** a hidden
 *     state — Redis-down paths log a warning and either skip dedupe entirely
 *     or use the in-process store; both are explicit operational choices.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md "Deduplication"
 */

/**
 * How long a claim survives without being confirmed.
 *
 * Bounds the damage of a process that dies between claim and publish: the
 * client's retry is rejected as a duplicate for at most this long, instead
 * of for the whole dedupe window.
 *
 * A module constant rather than config on purpose. It has no per-project
 * meaning, and this repository has a track record of shipping tuning knobs
 * that nothing reads.
 */
export const DEDUPE_LEASE_TTL_SEC = 60;

/** Identifies one dedupe entry. */
export interface DedupeKey {
  readonly projectId: string;
  readonly environment: string;
  readonly eventId: string;
}

/**
 * The two things a held entry can mean. Stored as the Redis value, because
 * the difference decides what a competing request is TOLD, and telling a
 * client `duplicate` about an event that was never published is exactly how
 * this layer used to lose events.
 */
export const DEDUPE_STATE_PENDING = "pending";
export const DEDUPE_STATE_CONFIRMED = "confirmed";

/** Outcome of a single dedupe claim attempt. */
export type DedupeClaimOutcome =
  /** This is the first observation inside the window. Caller publishes the event. */
  | { readonly status: "claimed" }
  /**
   * A CONFIRMED entry exists: the event reached `raw.events`. The caller
   * rejects with `duplicate`, and a producer may stop retrying.
   */
  | { readonly status: "duplicate" }
  /**
   * A PENDING lease exists — another request is mid-publish, or its process
   * died before resolving. The platform does not yet have the event, so the
   * caller rejects with `in_progress` and the producer retries after the
   * lease expires. Saying `duplicate` here would be a lie the producer acts
   * on by discarding the event.
   */
  | { readonly status: "in_progress" }
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
export interface DedupeClaimInput extends DedupeKey {
  /**
   * Lease TTL in seconds — how long the entry survives if the caller never
   * confirms. Callers pass {@link DEDUPE_LEASE_TTL_SEC}; the full per-project
   * window is applied later by `confirm`.
   */
  readonly ttlSec: number;
}

/** Input to `confirm`: the key plus the full window to extend it to. */
export interface DedupeConfirmInput extends DedupeKey {
  /** The resolved per-project dedupe window, in seconds. */
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
   * Promote a held lease to the full dedupe window. Called once the event is
   * durable in `raw.events`.
   *
   * Never throws, and callers do not await it: a failed promotion costs a
   * duplicate that slips through after the lease expires, which is precisely
   * the outcome this layer is allowed to have. Blocking the ingest response
   * on it would buy nothing.
   */
  confirm(input: DedupeConfirmInput): Promise<void>;
  /**
   * Drop a held lease so the caller's retry is not rejected as a duplicate.
   * Called when the publish failed.
   *
   * Never throws, and callers DO await it — the client is about to retry on
   * the strength of the response we are writing, so this is the one dedupe
   * call whose completion is worth latency.
   */
  release(input: DedupeKey): Promise<void>;
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
