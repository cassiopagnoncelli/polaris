/**
 * Touchpoint-chain store for attribution-engine v1.
 *
 * The store is keyed by the canonical
 * `<project_id>::<environment>::<kind>:<value>` string built by
 * `buildTouchpointStoreKey`. Values are `TouchpointChainRecord`s — the
 * runtime reads-then-writes during each handler call.
 *
 * State lives in PostgreSQL (ADR 0005). It used to live in a
 * process-local `Map` that never expired anything, which was two
 * problems in one: an unbounded map in a long-running service, and state
 * whose loss silently changes attribution results rather than costing a
 * bounded window.
 *
 * ## Why not Redis, when the sessionizer went to Redis
 *
 * Because the two states are shaped differently. A session record must
 * die at the inactivity window, so Redis expiry is the rule itself. A
 * touchpoint chain has no natural expiry — attribution windows run 30 to
 * 90 days — so a TTL store would hold an unbounded hot keyspace for
 * months. PostgreSQL bounds it, survives restarts, and makes chains
 * queryable, which is a capability operators did not have at all.
 *
 * @see processors/attribution-engine/v2/src/repository.ts
 */

import type { CampaignTuple, PrimaryIdentifierKind, TouchpointChainRecord } from "./transform.js";

/**
 * Contract for the touchpoint store. The runtime depends on this
 * interface so tests inject the in-memory adapter and production wires
 * the PostgreSQL-backed one (ADR 0005).
 *
 * Asynchronous because the production adapter is a database call.
 * `size()` stays off the interface — its SQL equivalent is a table scan,
 * which is not something a hot path should be able to reach for; the
 * in-memory adapter keeps it as a test affordance.
 */
export interface TouchpointStore {
  /** Read the active chain record for a key, or `undefined` when none. */
  get(store_key: string): Promise<TouchpointChainRecord | undefined>;
  /** Upsert the record for a key. The caller composes the record. */
  set(store_key: string, record: TouchpointChainRecord): Promise<void>;
  /** Drop the record for a key (no use in v1; reserved for future replay tooling). */
  delete(store_key: string): Promise<void>;
}

/** Pure in-memory `TouchpointStore`. Test adapter. */
export class InMemoryTouchpointStore implements TouchpointStore {
  readonly #records = new Map<string, TouchpointChainRecord>();

  async get(store_key: string): Promise<TouchpointChainRecord | undefined> {
    return this.#records.get(store_key);
  }

  async set(store_key: string, record: TouchpointChainRecord): Promise<void> {
    this.#records.set(store_key, record);
  }

  async delete(store_key: string): Promise<void> {
    this.#records.delete(store_key);
  }

  /** Record count. Test affordance. */
  size(): number {
    return this.#records.size;
  }

  /** Snapshot every record. Useful for tests. */
  snapshot(): ReadonlyArray<TouchpointChainRecord> {
    return Array.from(this.#records.values());
  }
}

/**
 * Helper: build the record for a freshly-opened chain (the first
 * touchpoint observation for an identifier). The runtime writes this
 * back after emitting touchpoint_captured + first_touch_assigned +
 * last_touch_assigned.
 */
export function buildFirstObservationRecord(input: {
  readonly project_id: string;
  readonly environment: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  readonly touchpoint_id: string;
  readonly campaign: CampaignTuple;
  readonly source_event_id: string;
  readonly observed_at: string;
}): TouchpointChainRecord {
  return {
    project_id: input.project_id,
    environment: input.environment,
    primary_identifier_kind: input.primary_identifier_kind,
    primary_identifier_value: input.primary_identifier_value,
    first_touchpoint_id: input.touchpoint_id,
    first_touchpoint_tuple: input.campaign,
    first_source_event_id: input.source_event_id,
    first_observed_at: input.observed_at,
    last_touchpoint_id: input.touchpoint_id,
    last_touchpoint_tuple: input.campaign,
    last_source_event_id: input.source_event_id,
    last_observed_at: input.observed_at,
    touchpoint_count: 1,
  };
}

/**
 * Helper: build the next record after a same-tuple repeat. Only the
 * `touchpoint_count` and `last_observed_at` change — the chain's
 * canonical touchpoint identity is preserved.
 *
 * NOTE: `last_source_event_id` is NOT advanced on a same-tuple repeat
 * because the chain's last-touch assignment still references the
 * original observation that established the tuple. The `last_observed_at`
 * timestamp moves forward so observability surfaces (e.g. "chain went
 * idle") can reason about chain freshness.
 */
export function buildSameTupleRecord(input: {
  readonly prior: TouchpointChainRecord;
  readonly observed_at: string;
}): TouchpointChainRecord {
  return {
    project_id: input.prior.project_id,
    environment: input.prior.environment,
    primary_identifier_kind: input.prior.primary_identifier_kind,
    primary_identifier_value: input.prior.primary_identifier_value,
    first_touchpoint_id: input.prior.first_touchpoint_id,
    first_touchpoint_tuple: input.prior.first_touchpoint_tuple,
    first_source_event_id: input.prior.first_source_event_id,
    first_observed_at: input.prior.first_observed_at,
    last_touchpoint_id: input.prior.last_touchpoint_id,
    last_touchpoint_tuple: input.prior.last_touchpoint_tuple,
    last_source_event_id: input.prior.last_source_event_id,
    last_observed_at: input.observed_at,
    touchpoint_count: input.prior.touchpoint_count + 1,
  };
}

/**
 * Helper: build the next record after a delta (the campaign tuple
 * differs from the prior last-touch tuple). The last-touch slot moves
 * to the new touchpoint; the first-touch slot is preserved.
 */
export function buildDeltaRecord(input: {
  readonly prior: TouchpointChainRecord;
  readonly touchpoint_id: string;
  readonly campaign: CampaignTuple;
  readonly source_event_id: string;
  readonly observed_at: string;
}): TouchpointChainRecord {
  return {
    project_id: input.prior.project_id,
    environment: input.prior.environment,
    primary_identifier_kind: input.prior.primary_identifier_kind,
    primary_identifier_value: input.prior.primary_identifier_value,
    first_touchpoint_id: input.prior.first_touchpoint_id,
    first_touchpoint_tuple: input.prior.first_touchpoint_tuple,
    first_source_event_id: input.prior.first_source_event_id,
    first_observed_at: input.prior.first_observed_at,
    last_touchpoint_id: input.touchpoint_id,
    last_touchpoint_tuple: input.campaign,
    last_source_event_id: input.source_event_id,
    last_observed_at: input.observed_at,
    touchpoint_count: input.prior.touchpoint_count + 1,
  };
}
