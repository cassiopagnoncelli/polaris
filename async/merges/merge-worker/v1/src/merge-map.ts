/**
 * The merge map: loser profile -> surviving profile.
 *
 * The whole reason this worker exists is that ClickHouse history is never
 * rewritten. An event written under a profile that later loses a merge stays
 * exactly as it was written — that row records what Polaris believed at the
 * time, and a delivery made under the loser's id really was made under that
 * id. Reads resolve through a dictionary instead.
 *
 * ## Transitive chains resolve at WRITE time
 *
 * This is the part with a decision in it. Merges compose:
 *
 *   day 1:  A -> B
 *   day 9:  B -> C
 *
 * A reader asking "who is A?" must land on C, not B. A ClickHouse dictionary
 * lookup cannot iterate, so if the map stored the two rows as emitted, a
 * query would resolve one hop and stop — silently under-merging, with no
 * error anywhere and a number that is merely wrong.
 *
 * So the chain collapses here: when B -> C arrives, every row already
 * pointing at B is rewritten to point at C. Reads stay a single lookup, and
 * the cost lands on the rare write rather than on every query.
 *
 * The alternative — resolving chains at read time — would need either a
 * recursive CTE per query or a fixed unroll depth. The first is expensive on
 * every person-keyed read; the second is a limit nobody would remember they
 * had until a customer merged three accounts.
 *
 * ## Ordering
 *
 * `_version` is the merge's wall-clock time in milliseconds, and
 * `ReplacingMergeTree(_version)` keeps the highest. A transitive rewrite
 * therefore has to carry a version at least as high as the merge that
 * triggered it, or the collapse would lose to the row it was correcting.
 * `buildMergeRows` stamps every row it produces with the TRIGGERING merge's
 * timestamp for exactly that reason.
 */

import type {
  MergeMapChainEntry as ExistingChain,
  MergeMapRow,
} from "@polaris/persistence-clickhouse";

/** One `identity.merged` v2 event, reduced to what the map needs. */
export interface MergeEvent {
  readonly project_id: string;
  readonly environment: string;
  readonly winner_profile_id: string;
  readonly loser_profile_id: string;
  readonly merge_id: string;
  readonly reason: string;
  /** ISO-8601. The merge's own clock, not the worker's. */
  readonly occurred_at: string;
}

// The row and chain shapes come from `@polaris/persistence-clickhouse`, which
// owns the table. Declaring them again here would be a second copy of a
// DDL's column list, and the two would drift the first time a column moved.
export type {
  MergeMapChainEntry as ExistingChain,
  MergeMapRow,
} from "@polaris/persistence-clickhouse";

/**
 * Rows to upsert for one merge event.
 *
 * Returns the direct mapping plus a rewrite for every entry that pointed at
 * the newly-tombstoned profile. Pure: no clock, no I/O — the timestamp comes
 * from the event so a replay produces byte-identical rows.
 */
export function buildMergeRows(
  event: MergeEvent,
  chained: readonly ExistingChain[],
): readonly MergeMapRow[] {
  const version = Date.parse(event.occurred_at);
  // A merge with an unparseable timestamp would stamp NaN and lose every
  // collapse race. Refusing is better than writing a row that will be
  // silently overwritten by anything.
  if (!Number.isFinite(version)) {
    throw new RangeError(
      `identity.merged carries an unparseable occurred_at: ${event.occurred_at}`,
    );
  }

  const direct: MergeMapRow = {
    project_id: event.project_id,
    environment: event.environment,
    loser_profile_id: event.loser_profile_id,
    winner_profile_id: event.winner_profile_id,
    merge_id: event.merge_id,
    reason: event.reason,
    merged_at: event.occurred_at,
    _version: version,
  };

  const rewrites = chained
    // A row already pointing at the winner needs no rewrite, and emitting
    // one would be a no-op write on every merge in a long chain.
    .filter((entry) => entry.loser_profile_id !== event.winner_profile_id)
    .map<MergeMapRow>((entry) => ({
      project_id: event.project_id,
      environment: event.environment,
      loser_profile_id: entry.loser_profile_id,
      winner_profile_id: event.winner_profile_id,
      merge_id: entry.merge_id,
      // The original reason, kept: this row's lineage is still the merge
      // that created it. Overwriting it with the triggering merge's reason
      // would make the map claim A and B merged for the same cause when
      // they did not.
      reason: entry.reason,
      merged_at: event.occurred_at,
      // The TRIGGERING merge's version — see the module header. A rewrite
      // stamped with its own original time would lose to the row it corrects.
      _version: version,
    }));

  return [direct, ...rewrites];
}

/**
 * Whether a merge event is one this worker should act on.
 *
 * A self-merge — winner and loser equal — is not a merge, and writing it
 * would put a row in the dictionary mapping a profile to itself. Harmless to
 * read, but it makes "is this profile merged?" answer yes for a profile that
 * is not, which is the kind of thing that reads as a bug for an afternoon.
 */
export function isActionableMerge(event: MergeEvent): boolean {
  return event.winner_profile_id !== event.loser_profile_id;
}
