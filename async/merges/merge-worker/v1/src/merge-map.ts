/**
 * The ClickHouse half of the merge map.
 *
 * What a merge MEANS for the map — that merges compose, that the chain
 * collapses on the way in so a dictionary lookup never has to iterate,
 * that a rewrite carries the triggering merge's version — moved to
 * `@polaris/identity-components` when ADR-0007's third law was applied
 * to this worker. That is incremental connected components over
 * profiles, and it is version-invariant physics: `polaris profiles
 * rebuild` replays the same merges, and the rows it produces have to
 * match the ones the live path produced.
 *
 * What is left here is the projection onto the storage this worker
 * happens to use: read an `identity.merged` v2 envelope into the
 * domain's shape, and write the domain's assignments as
 * `polaris.profile_merge_map` rows.
 *
 * ## Two shapes, on purpose
 *
 * `MergeEvent` keeps the envelope's snake_case because that is what
 * arrives on the wire, and `MergeMapRow` comes from
 * `@polaris/persistence-clickhouse`, which owns the table — declaring it
 * again here would be a second copy of a DDL's column list, and the two
 * would drift the first time a column moved. The domain sits between
 * them in its own vocabulary, and the two mappings below are the seam
 * where either change becomes a type error in one file rather than
 * silence in two.
 *
 * `project_id` and `environment` never reach the domain: they are the
 * map's partition scope, not something the collapse reasons about, and
 * the whole result of one merge lands in one scope.
 */

import {
  collapseComponent,
  type ComponentAssignment,
  type ComponentEntry,
  isActionableMerge as isActionableProfileMerge,
  type ProfileMerge,
} from "@polaris/identity-components";
import type {
  MergeMapChainEntry as ExistingChain,
  MergeMapRow,
} from "@polaris/persistence-clickhouse";

export type {
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

function toProfileMerge(event: MergeEvent): ProfileMerge {
  return {
    loserProfileId: event.loser_profile_id,
    winnerProfileId: event.winner_profile_id,
    mergeId: event.merge_id,
    reason: event.reason,
    occurredAt: event.occurred_at,
  };
}

function toRow(event: MergeEvent, assignment: ComponentAssignment): MergeMapRow {
  return {
    project_id: event.project_id,
    environment: event.environment,
    loser_profile_id: assignment.loserProfileId,
    winner_profile_id: assignment.winnerProfileId,
    merge_id: assignment.mergeId,
    reason: assignment.reason,
    merged_at: assignment.mergedAt,
    _version: assignment.version,
  };
}

/** Whether a merge event is one this worker should act on. */
export function isActionableMerge(event: MergeEvent): boolean {
  return isActionableProfileMerge(toProfileMerge(event));
}

/**
 * Rows to upsert for one merge event.
 *
 * The direct mapping plus a rewrite for every entry that pointed at the
 * newly-tombstoned profile. Pure: no clock, no I/O — the timestamp comes
 * from the event so a replay produces byte-identical rows.
 */
export function buildMergeRows(
  event: MergeEvent,
  chained: readonly ExistingChain[],
): readonly MergeMapRow[] {
  const entries: readonly ComponentEntry[] = chained.map((entry) => ({
    loserProfileId: entry.loser_profile_id,
    mergeId: entry.merge_id,
    reason: entry.reason,
  }));

  return collapseComponent(toProfileMerge(event), entries).map((assignment) =>
    toRow(event, assignment),
  );
}
