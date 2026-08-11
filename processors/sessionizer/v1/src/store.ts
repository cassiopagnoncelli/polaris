/**
 * Session store for sessionizer v1.
 *
 * The store is keyed by the canonical
 * `<project_id>::<environment>::<kind>:<value>` string built by
 * `buildSessionStoreKey`. Values are `SessionRecord`s — the runtime
 * reads-then-writes during each handler call.
 *
 * State lives in Redis (ADR 0005). The store's contract is deliberately
 * expiry-aware: every write carries the inactivity window as a TTL, so
 * the storage layer forgets a session at exactly the moment the domain
 * says it is over. That is why the old `gcExpired()` helper is gone
 * rather than promoted to a timer — there is nothing left to sweep.
 *
 * ## TTL is a storage bound, not the session decision
 *
 * `decideSession` compares `last_seen_at + inactivity_seconds` against
 * the *event's* `occurred_at`; the TTL is wall-clock. The two coincide
 * for live traffic and diverge during replay, where hours of event time
 * compress into seconds of wall clock. That divergence is safe in the
 * only direction it can go: a replay may still find a prior record that
 * event-time says is stale, and `decideSession` then correctly decides
 * to expire it and open a new session. The transform owns the decision;
 * the TTL only bounds how long a record occupies memory.
 *
 * ## Both adapters expire lazily
 *
 * `InMemorySessionStore` models the same TTL semantics as Redis rather
 * than holding records forever. An in-memory adapter that never expired
 * would make every test pass against behaviour production does not have.
 */

import type { PrimaryIdentifierKind, SessionRecord } from "./transform.js";

/**
 * Contract for the session store. The runtime depends on this interface
 * so tests inject the in-memory adapter and production wires the
 * Redis-backed one.
 *
 * Asynchronous because the production adapter is a network call. The
 * three methods here are all the runtime uses; `size()` and `snapshot()`
 * live on the in-memory adapter as test affordances rather than on the
 * interface, because their Redis equivalents (`DBSIZE`, `SCAN`) are
 * operations no hot path should be able to reach for.
 */
export interface SessionStore {
  /** Read the active record for a key, or `undefined` when none. */
  get(store_key: string): Promise<SessionRecord | undefined>;
  /**
   * Upsert the record for a key, with the inactivity window as its TTL.
   * Each write re-arms the expiry, which is what makes an active session
   * survive and an abandoned one fall out on its own.
   */
  set(store_key: string, record: SessionRecord, ttl_seconds: number): Promise<void>;
  /** Drop the record for a key (used after `session.ended` emission). */
  delete(store_key: string): Promise<void>;
}

/**
 * In-memory `SessionStore` with Redis-equivalent TTL semantics. Test
 * adapter; production uses `RedisSessionStore`.
 */
export class InMemorySessionStore implements SessionStore {
  readonly #records = new Map<string, { record: SessionRecord; expires_at_ms: number }>();
  readonly #now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? ((): number => Date.now());
  }

  async get(store_key: string): Promise<SessionRecord | undefined> {
    const entry = this.#records.get(store_key);
    if (entry === undefined) return undefined;
    if (entry.expires_at_ms <= this.#now()) {
      // Lazy expiry, matching Redis: a key past its TTL reads as absent.
      this.#records.delete(store_key);
      return undefined;
    }
    return entry.record;
  }

  async set(store_key: string, record: SessionRecord, ttl_seconds: number): Promise<void> {
    this.#records.set(store_key, {
      record,
      expires_at_ms: this.#now() + ttl_seconds * 1000,
    });
  }

  async delete(store_key: string): Promise<void> {
    this.#records.delete(store_key);
  }

  /** Live (unexpired) record count. Test affordance. */
  size(): number {
    const now = this.#now();
    let live = 0;
    for (const entry of this.#records.values()) {
      if (entry.expires_at_ms > now) live += 1;
    }
    return live;
  }

  /** Snapshot every live record. Useful for tests. */
  snapshot(): ReadonlyArray<SessionRecord> {
    const now = this.#now();
    return Array.from(this.#records.values())
      .filter((entry) => entry.expires_at_ms > now)
      .map((entry) => entry.record);
  }
}

/**
 * Helper: build the next `SessionRecord` given the prior (if any) plus
 * the new event. Pure — the runtime calls this to compute the value it
 * writes back via `store.set`.
 */
export function buildContinuedRecord(input: {
  readonly prior: SessionRecord;
  readonly raw_event_id: string;
  readonly raw_occurred_at: string;
}): SessionRecord {
  return {
    session_id: input.prior.session_id,
    project_id: input.prior.project_id,
    environment: input.prior.environment,
    primary_identifier_kind: input.prior.primary_identifier_kind,
    primary_identifier_value: input.prior.primary_identifier_value,
    started_at: input.prior.started_at,
    last_seen_at: input.raw_occurred_at,
    event_count: input.prior.event_count + 1,
    source_event_id: input.prior.source_event_id,
  };
}

/**
 * Build the record for a freshly-opened session. The caller supplies
 * `session_id` and `started_at` from the `decideSession` decision; this
 * helper just fills the bookkeeping fields.
 */
export function buildOpenedRecord(input: {
  readonly session_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  readonly started_at: string;
  readonly source_event_id: string;
}): SessionRecord {
  return {
    session_id: input.session_id,
    project_id: input.project_id,
    environment: input.environment,
    primary_identifier_kind: input.primary_identifier_kind,
    primary_identifier_value: input.primary_identifier_value,
    started_at: input.started_at,
    last_seen_at: input.started_at,
    event_count: 1,
    source_event_id: input.source_event_id,
  };
}
