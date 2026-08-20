/**
 * Deterministic identifiers for derived events.
 *
 * Every processor minted `uuidv7()` per emission attempt, so the same input
 * replayed — or simply redelivered, which at-least-once guarantees — produced
 * a NEW derived event each time. Two consequences, both live today:
 *
 *   - `analytics_processed` is `ReplacingMergeTree` keyed on
 *     `(project_id, environment, event, event_id)`. Random ids mean the
 *     duplicates never collapse; they accumulate as distinct facts.
 *   - `sql/clickhouse/32_analytics_processed.sql` justifies that engine choice
 *     with "Derived events carry deterministic event_ids (a replay of the same
 *     input reproduces the same id)". It was not true when written.
 *
 * A derived event is a pure function of its cause, so its identity should be
 * too: same source event, same processor, same emission slot → same id.
 *
 * ## What is deliberately NOT in the key
 *
 * `processor_version`. Every instinct says to include it — different code,
 * different output, different identity — and it makes replay-as-repair
 * impossible by construction. The only reason to replay is that you shipped a
 * fix; a fix bumps the version; a bumped version mints a fresh id generation
 * that collides with, and therefore replaces, nothing. You would be left with
 * both the wrong rows and the right ones. Version travels as a payload column,
 * where a query can filter on it and `_version` can order it.
 *
 * ## The slot invariant
 *
 * `slot` distinguishes multiple emissions from one source event. It MUST be a
 * pure function of the source event — never of stored state, and never of a
 * decision the processor made by reading a store.
 *
 * The reason is concrete. A processor whose emitted event NAME depends on
 * repository state can emit `identity.merged` on the first attempt and
 * `identity.linked` on a retry, because the first attempt's write landed
 * before its publish failed. `event` is the third column of the ClickHouse
 * sort key, so those two rows fall into different groups and no id scheme can
 * collapse them. Keying the slot on a state-dependent decision hides that
 * problem behind a stable-looking id instead of surfacing it.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Metadata"
 */

import { v5 as uuidv5 } from "uuid";

/**
 * Namespace for every Polaris derived event id.
 *
 * Module-private: no caller outside this package has a reason to reference it,
 * and `pnpm lint:dead-exports` flagged the export within an hour of it being
 * written. Its value is pinned by the key-material test instead.
 *
 * A fixed UUIDv4, generated once and frozen. Changing it re-mints every
 * derived id in existence, so it is effectively part of the storage format.
 */
const POLARIS_DERIVED_EVENT_NAMESPACE = "6f2a1c84-9c1e-4f7b-8a30-1d5c6b0e9f42";

export interface DeriveEventIdInput {
  /**
   * Processor name — NOT `<name> v<version>`. See the module header for why
   * the version is excluded.
   */
  readonly processor: string;
  /** `event_id` of the source event this emission was derived from. */
  readonly sourceEventId: string;
  /**
   * Which of this processor's emissions this is, for a source event that
   * produces more than one. Must be a pure function of the source event.
   */
  readonly slot: string;
}

/**
 * Compute a derived event's id.
 *
 * UUIDv5 (SHA-1 over namespace + name), so the output is a syntactically
 * valid UUID that satisfies the envelope's `z.string().uuid()` — no schema
 * change, no new dependency, and the same input always yields the same id on
 * any machine and in any process.
 */
export function deriveEventId(input: DeriveEventIdInput): string {
  return uuidv5(
    `${input.processor}|${input.sourceEventId}|${input.slot}`,
    POLARIS_DERIVED_EVENT_NAMESPACE,
  );
}
