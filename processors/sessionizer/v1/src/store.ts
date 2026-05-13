/**
 * In-memory session store for sessionizer v1.
 *
 * The store is keyed by the canonical
 * `<project_id>::<environment>::<kind>:<value>` string built by
 * `buildSessionStoreKey`. Values are mutable `SessionRecord`s — the
 * runtime reads-then-writes during each handler call.
 *
 * v1 is intentionally in-memory: crash-induced loss of windows is
 * acceptable because (a) the window is 30 minutes, (b) the processor is
 * replayable from `raw.events`, and (c) the deterministic `session_id`
 * derivation means a replay reproduces the same output. A Redis-backed
 * v2 will externalize the state store with a similar contract (see
 * CHANGELOG.md "Known v1 limitations").
 *
 * The store does not expire records on its own — expiration is the
 * pure `decideSession` transform's job. The store offers an explicit
 * `gcExpired()` helper so a future timer-driven background sweep can
 * cull idle records; v1's runtime does NOT call it because lazy
 * expiration on the next observed event for a key is sufficient.
 */

import type { PrimaryIdentifierKind, SessionRecord } from "./transform.js";

/**
 * Contract for the session store. The runtime depends on this interface
 * so tests inject the in-memory adapter and a future v2 swaps in a
 * Redis-backed implementation.
 */
export interface SessionStore {
  /** Read the active record for a key, or `undefined` when none. */
  get(store_key: string): SessionRecord | undefined;
  /** Upsert the record for a key. The caller composes the record. */
  set(store_key: string, record: SessionRecord): void;
  /** Drop the record for a key (used after `session.ended` emission). */
  delete(store_key: string): void;
  /**
   * Garbage-collect every record whose `last_seen_at + inactivity_seconds`
   * is strictly less than `now`. Returns the deleted records so the
   * caller can emit `session.ended` for each. v1 does not call this;
   * the helper exists for future timer-driven sweeps.
   */
  gcExpired(input: { readonly inactivity_seconds: number; readonly now: Date }): SessionRecord[];
  /** Current size of the store. Used by metrics. */
  size(): number;
}

/** Pure in-memory `SessionStore`. */
export class InMemorySessionStore implements SessionStore {
  readonly #records = new Map<string, SessionRecord>();

  get(store_key: string): SessionRecord | undefined {
    return this.#records.get(store_key);
  }

  set(store_key: string, record: SessionRecord): void {
    this.#records.set(store_key, record);
  }

  delete(store_key: string): void {
    this.#records.delete(store_key);
  }

  gcExpired(input: { readonly inactivity_seconds: number; readonly now: Date }): SessionRecord[] {
    const expired: SessionRecord[] = [];
    const boundaryMs = input.now.getTime() - input.inactivity_seconds * 1000;
    for (const [key, record] of this.#records) {
      const lastSeenMs = Date.parse(record.last_seen_at);
      if (Number.isFinite(lastSeenMs) && lastSeenMs < boundaryMs) {
        expired.push(record);
        this.#records.delete(key);
      }
    }
    return expired;
  }

  size(): number {
    return this.#records.size;
  }

  /** Snapshot every record. Useful for tests. */
  snapshot(): ReadonlyArray<SessionRecord> {
    return Array.from(this.#records.values());
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
