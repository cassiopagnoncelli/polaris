/**
 * `@polaris/identity-components` — who a merged-away profile became.
 *
 * One of the four modules ADR-0007 decomposes the identity subsystem
 * into, and the one that exists because history is never rewritten. An
 * event written under a profile that later loses a merge stays exactly
 * as it was written: that row records what Polaris believed at the time,
 * and a delivery made under the loser's id really was made under that
 * id. Reads resolve through a component map instead.
 *
 * The map is a disjoint-set forest — profiles are the elements, a merge
 * is a union, and the surviving profile is the component's root — kept
 * under EAGER, FULL path compression.
 *
 * ## Why the compression is eager
 *
 * Merges compose:
 *
 *   day 1:  A -> B
 *   day 9:  B -> C
 *
 * A reader asking "who is A?" must land on C, not B. The consumer of
 * this map is a ClickHouse dictionary lookup, and a dictionary cannot
 * iterate — so a map storing the two edges as they arrived would resolve
 * one hop and stop, silently under-merging, with no error anywhere and a
 * number that is merely wrong.
 *
 * So the chain collapses on the way in: when B -> C arrives, every entry
 * already pointing at B is rewritten to point at C. Reads stay a single
 * lookup, and the cost lands on the rare write rather than on every
 * query. The alternative — resolving chains at read time — needs either
 * a recursive CTE per query or a fixed unroll depth. The first is
 * expensive on every person-keyed read; the second is a limit nobody
 * would remember they had until a customer merged three accounts.
 *
 * ## Ordering
 *
 * Assignments carry a version taken from the merge's own clock, because
 * the store they land in keeps the highest version per element. A
 * transitive rewrite must therefore carry a version at least as high as
 * the merge that TRIGGERED it, or the collapse would lose to the row it
 * was correcting. Every assignment `collapseComponent` produces is
 * stamped with the triggering merge's time for exactly that reason.
 */

/** One merge, reduced to what the forest needs. */
export interface ProfileMerge {
  /** The profile that stops being a root. */
  readonly loserProfileId: string;
  /** The profile that survives — the component's root. */
  readonly winnerProfileId: string;
  readonly mergeId: string;
  readonly reason: string;
  /** ISO-8601. The merge's own clock, not the reader's. */
  readonly occurredAt: string;
}

/** An entry already in the forest that currently resolves TO some profile. */
export interface ComponentEntry {
  readonly loserProfileId: string;
  readonly mergeId: string;
  readonly reason: string;
}

/** One element's membership, as it should be stored. */
export interface ComponentAssignment {
  readonly loserProfileId: string;
  readonly winnerProfileId: string;
  readonly mergeId: string;
  readonly reason: string;
  readonly mergedAt: string;
  readonly version: number;
}

/**
 * Whether a merge is one the forest should act on.
 *
 * A self-merge — winner and loser equal — is not a merge, and storing it
 * would map a profile to itself. Harmless to read, but it makes "is this
 * profile merged?" answer yes for a profile that is not, which is the
 * kind of thing that reads as a bug for an afternoon.
 */
export function isActionableMerge(merge: ProfileMerge): boolean {
  return merge.winnerProfileId !== merge.loserProfileId;
}

/**
 * Fold one merge into the forest, compressing the chain it extends.
 *
 * Returns the direct assignment plus a rewrite for every entry that
 * pointed at the newly-tombstoned profile. Pure: no clock, no I/O — the
 * timestamp comes from the merge, so a replay produces byte-identical
 * assignments.
 *
 * `chained` is every entry whose root is the incoming loser. Reading it
 * is the caller's job because it is a query against wherever the forest
 * lives; on a merge of two never-merged profiles — the overwhelming
 * majority — it is empty and the result is a single assignment.
 */
export function collapseComponent(
  merge: ProfileMerge,
  chained: readonly ComponentEntry[],
): readonly ComponentAssignment[] {
  const version = Date.parse(merge.occurredAt);
  // A merge with an unparseable timestamp would stamp NaN and lose every
  // collapse race. Refusing is better than writing an assignment that
  // will be silently overwritten by anything.
  if (!Number.isFinite(version)) {
    throw new RangeError(`a merge carries an unparseable occurred_at: ${merge.occurredAt}`);
  }

  const direct: ComponentAssignment = {
    loserProfileId: merge.loserProfileId,
    winnerProfileId: merge.winnerProfileId,
    mergeId: merge.mergeId,
    reason: merge.reason,
    mergedAt: merge.occurredAt,
    version,
  };

  const rewrites = chained
    // An entry already pointing at the winner needs no rewrite, and
    // emitting one would be a no-op write on every merge in a long chain.
    .filter((entry) => entry.loserProfileId !== merge.winnerProfileId)
    .map<ComponentAssignment>((entry) => ({
      loserProfileId: entry.loserProfileId,
      winnerProfileId: merge.winnerProfileId,
      mergeId: entry.mergeId,
      // The original reason, kept: this entry's lineage is still the merge
      // that created it. Overwriting it with the triggering merge's reason
      // would claim A and B merged for a cause they did not.
      reason: entry.reason,
      mergedAt: merge.occurredAt,
      // The TRIGGERING merge's version — see the module header. A rewrite
      // stamped with its own original time would lose to the row it corrects.
      version,
    }));

  return [direct, ...rewrites];
}
