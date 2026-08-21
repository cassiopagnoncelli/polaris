/**
 * Which of two profiles survives a merge.
 *
 * The rule is "the older profile wins, ties broken by the lower id", and
 * the reason it is a rule rather than a preference is replay. Unmerge is
 * replay-rebuild (see `./unmerge.ts`), so the same events replayed must
 * pick the same survivor — otherwise a rebuild that was supposed to
 * repair one bad merge re-mints every profile id downstream of it, and
 * every `profile_id` already stamped into ClickHouse history stops
 * resolving.
 *
 * Both halves of the rule are therefore load-bearing. `first_seen_at`
 * alone is not a total order: two profiles created inside the same
 * millisecond compare equal, and "whichever the database returned first"
 * is not a rule at all. The id tiebreak makes the order total, and it
 * compares as a STRING because that is what the ids are — uuidv7 in
 * production, so string order is creation order anyway, and a padded
 * counter in the fakes for the same reason.
 */

/** One side of a candidate merge, reduced to what the decision needs. */
export interface MergeCandidate {
  readonly profileId: string;
  readonly firstSeenAt: Date;
}

export interface MergeSelection<T extends MergeCandidate> {
  readonly winner: T;
  /** Every other candidate, in the same total order. */
  readonly losers: readonly T[];
}

/**
 * Order the candidates and split off the survivor.
 *
 * Returns `null` for fewer than two candidates: that is not a merge, and
 * a caller that routed here with one profile has a bug worth surfacing
 * rather than a merge worth performing.
 */
export function selectMergeWinner<T extends MergeCandidate>(
  candidates: readonly T[],
): MergeSelection<T> | null {
  if (candidates.length < 2) return null;

  const ordered = [...candidates].sort((a, b) => {
    const at = a.firstSeenAt.getTime();
    const bt = b.firstSeenAt.getTime();
    if (at !== bt) return at - bt;
    return a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0;
  });

  const winner = ordered[0];
  if (winner === undefined) return null;
  return { winner, losers: ordered.slice(1) };
}
