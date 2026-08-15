/**
 * Diffing computed traits against what a profile already carries.
 *
 * The runner's whole job in one pure function, and the reason it is pure is
 * that every interesting decision here is about SEMANTICS rather than I/O.
 *
 * ## Absent is a removal, not a zero
 *
 * A profile missing from a trait's result has NO value for that trait. The
 * runner writes that as a removal.
 *
 * The tempting alternative — default to `0` — makes "this customer has
 * ordered nothing in 30 days" indistinguishable from "we have not computed
 * this". An audience built on `orders_30d = 0` would then quietly include
 * every profile the trait has never seen, which is most of them on the first
 * run of a new trait.
 *
 * ## Only changes are written
 *
 * A trait recomputed to the same value is not a write. This matters more
 * than it looks: `traits_version` is what a destination uses to tell whether
 * a profile it already sent has moved on, and bumping it nightly for every
 * profile whose traits did not change would make every consumer of that
 * signal useless.
 *
 * ## One version bump per profile, not per trait
 *
 * Three traits changing on one profile in one run is ONE change to that
 * profile. Bumping per trait would make `traits_version` count computations
 * rather than describe the profile, and a reader comparing versions across
 * two profiles would learn nothing.
 */

/** What a definition computed for one profile. */
export interface ComputedValue {
  readonly profileId: string;
  readonly value: unknown;
}

/** A profile's traits as currently stored. */
export interface StoredTraits {
  readonly profileId: string;
  readonly traits: Readonly<Record<string, unknown>>;
}

/** One profile's trait changes from a run. */
export interface TraitChange {
  readonly profileId: string;
  /** Keys to set, with their new values. */
  readonly set: Readonly<Record<string, unknown>>;
  /** Keys to remove — computed to nothing this run. */
  readonly remove: readonly string[];
}

/**
 * Diff one trait's computed values against stored traits.
 *
 * `computed` is the full result for the trait; `stored` is every profile
 * that currently carries a value for it. A profile in `stored` but not in
 * `computed` gets a removal; one in both with an equal value gets nothing.
 *
 * Scoped to the profiles the caller supplies rather than the whole store:
 * a trait's result set IS the population it applies to, plus whoever used
 * to be in it.
 */
export function diffTrait(input: {
  readonly key: string;
  readonly computed: readonly ComputedValue[];
  readonly stored: readonly StoredTraits[];
}): readonly TraitChange[] {
  const computedBy = new Map(input.computed.map((row) => [row.profileId, row.value]));
  const storedBy = new Map(input.stored.map((row) => [row.profileId, row.traits[input.key]]));

  const changes: TraitChange[] = [];

  for (const [profileId, value] of computedBy) {
    const current = storedBy.get(profileId);
    // `sameValue`, not `===`: a trait's value can be a number that
    // round-tripped through JSON, and a spurious "change" would bump
    // traits_version and re-notify every destination for nothing.
    if (sameValue(current, value)) continue;
    changes.push({ profileId, set: { [input.key]: value }, remove: [] });
  }

  for (const [profileId, current] of storedBy) {
    if (current === undefined) continue;
    if (computedBy.has(profileId)) continue;
    // Present before, absent now. A removal — see the module header.
    changes.push({ profileId, set: {}, remove: [input.key] });
  }

  return changes;
}

/**
 * Merge per-trait changes into one change per profile.
 *
 * This is what makes `traits_version` bump once per profile per run rather
 * than once per trait.
 */
export function mergeChanges(
  perTrait: readonly (readonly TraitChange[])[],
): readonly TraitChange[] {
  const byProfile = new Map<string, { set: Record<string, unknown>; remove: Set<string> }>();

  for (const changes of perTrait) {
    for (const change of changes) {
      const entry = byProfile.get(change.profileId) ?? { set: {}, remove: new Set<string>() };
      Object.assign(entry.set, change.set);
      for (const key of change.remove) entry.remove.add(key);
      byProfile.set(change.profileId, entry);
    }
  }

  return [...byProfile.entries()].map(([profileId, entry]) => ({
    profileId,
    set: entry.set,
    remove: [...entry.remove],
  }));
}

/**
 * Value equality for trait comparison.
 *
 * Structural, because a trait may hold an object and reference equality
 * would report every run as a change. Numbers compare by value so an
 * integer that came back as `3` and one stored as `3.0` are the same trait.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
