/**
 * Evaluating one audience definition into a population, and that
 * population into signals.
 *
 * Two pure steps, and between them the whole of what an audience run
 * DECIDES. What it does about the decision — reading traits, writing
 * membership rows, publishing `audience.entered` — is the runtime's, and
 * lives in `async/computation/audiences/v1`.
 *
 * ## Why the population is computed from rows the caller already has
 *
 * `membersMatching` takes trait rows rather than a store. A trait-sourced
 * audience is a predicate over a bag of values that somebody else fetched;
 * making the evaluator fetch them would give this module a database, a
 * connection failure mode, and a reason to be mocked in every test that
 * wants to ask a question about a predicate.
 *
 * `traitsReferenced` (in `@polaris/audience-catalog`) says WHICH keys to
 * fetch, so the narrowing that bounds the population is still stated in
 * one place — the runtime asks the catalog, fetches, and hands the rows
 * here.
 *
 * A `projection` audience never reaches `membersMatching` at all: its
 * population is whatever its SQL returned, and the runtime passes that set
 * straight to `planAudience`. That asymmetry is the point of the two
 * sources, not an omission here.
 *
 * ## The diff has one caller, so it is not a public function
 *
 * `planAudience` IS the diff plus the counts, and every caller wants both.
 * A separately exported `diffAudience` would be a second entry point into
 * the same decision, and the runtime that took it would report numbers it
 * recounted itself.
 *
 * ## Why the plan carries the summary
 *
 * `planAudience` returns the counts alongside the transitions because they
 * are derived from the same three inputs, and a caller recomputing
 * `entered` by filtering the transitions it was just handed is a second
 * definition of the number that can drift from the first. The runtime
 * reports what the plan says it did.
 */

import type { AudienceDefinition, AudiencePredicate } from "@polaris/audience-catalog";

import type { AudienceTransition, StoredMembership } from "./signals.js";
import { evaluatePredicate, type TraitBag } from "./predicate.js";

/** One profile's traits, as the runtime read them. */
export interface ProfileTraits {
  readonly profileId: string;
  readonly traits: TraitBag;
}

/** A stored membership row with the definition version that last stamped it. */
export interface StampedMembership extends StoredMembership {
  readonly audienceVersion: number;
}

/** What one audience did in one run. */
export interface AudienceSummary {
  readonly key: string;
  readonly version: number;
  readonly members: number;
  readonly entered: number;
  readonly exited: number;
  readonly restamped: number;
}

export interface AudiencePlan {
  /** Membership changes, each of which the runtime writes and then announces. */
  readonly transitions: readonly AudienceTransition[];
  /** Members whose version stamp is stale: a write, and no event. */
  readonly restamp: readonly string[];
  readonly summary: AudienceSummary;
}

/**
 * The profiles among `profiles` that satisfy `predicate`.
 *
 * Iteration order is the caller's, and the returned set preserves it. The
 * runtime's fixture-stream check rests on that: a population that reordered
 * itself would emit the same transitions in a different order, which is a
 * different stream to anything reading it.
 */
export function membersMatching(
  predicate: AudiencePredicate,
  profiles: Iterable<ProfileTraits>,
): ReadonlySet<string> {
  const members = new Set<string>();
  for (const profile of profiles) {
    if (evaluatePredicate(predicate, profile.traits)) members.add(profile.profileId);
  }
  return members;
}

/** What this run should write and emit for one audience. */
export function planAudience(input: {
  readonly definition: AudienceDefinition;
  /** Profiles the definition says are members right now. */
  readonly desired: ReadonlySet<string>;
  /** Every stored row for this audience in this scope, open and closed. */
  readonly stored: readonly StampedMembership[];
}): AudiencePlan {
  const diff = diffAudience({
    desired: input.desired,
    stored: input.stored,
    version: input.definition.version,
  });

  let entered = 0;
  let exited = 0;
  for (const transition of diff.transitions) {
    if (transition.kind === "entered") entered += 1;
    else exited += 1;
  }

  return {
    transitions: diff.transitions,
    restamp: diff.restamp,
    summary: {
      key: input.definition.key,
      version: input.definition.version,
      members: input.desired.size,
      entered,
      exited,
      restamped: diff.restamp.length,
    },
  };
}

/**
 * The population against what is stored: which changes are signals.
 *
 * ## Transitions only
 *
 * A profile that qualified yesterday and qualifies today produces nothing.
 * This is the property the whole design rests on: `audience.entered` and
 * `audience.exited` are consumed as CHANGES, so a run over an unchanged
 * population must be silent. An audience of two million members
 * re-emitting nightly would be two million vendor writes a day describing
 * nothing.
 *
 * It is also what makes the runner idempotent. Re-running the same
 * computation writes nothing and emits nothing the second time, so cron
 * overlapping a manual invocation is safe and the command needs no lock —
 * the same argument the traits runner makes.
 *
 * ## A version bump is not a re-entry
 *
 * `audience_version` stamps which definition version last evaluated a row,
 * NOT which one the profile joined under. A profile that qualifies under
 * both v1 and v2 stays a member and has its stamp updated; it does not
 * exit v1 and enter v2.
 *
 * The alternative — scoping membership by version — was rejected because
 * it makes every predicate tweak, including a typo fix, exit and re-enter
 * the entire population. Downstream that is indistinguishable from every
 * customer genuinely leaving and rejoining overnight, and a suppression
 * audience would briefly show nobody suppressed. A version bump changes
 * how membership is DERIVED; it is not an event in any person's life.
 *
 * ## Re-entry is distinguishable from first entry
 *
 * An exited membership row survives its exit, so the diff knows a
 * returning profile has been here before and stamps `re_entry` on the
 * transition. A destination running a welcome campaign needs that and
 * cannot derive it from the stream alone.
 */
function diffAudience(input: {
  readonly desired: ReadonlySet<string>;
  readonly stored: readonly StampedMembership[];
  readonly version: number;
}): { readonly transitions: readonly AudienceTransition[]; readonly restamp: readonly string[] } {
  const storedBy = new Map(input.stored.map((row) => [row.profileId, row]));

  const transitions: AudienceTransition[] = [];
  const restamp: string[] = [];

  for (const profileId of input.desired) {
    const row = storedBy.get(profileId);
    if (row === undefined) {
      // Never seen. First entry.
      transitions.push({ kind: "entered", profileId, reEntry: false });
      continue;
    }
    if (row.exitedAt !== null) {
      // Was a member, left, qualifies again. The surviving row is what
      // lets us say so.
      transitions.push({ kind: "entered", profileId, reEntry: true });
      continue;
    }
    // Still a member. Silent — unless the stamp is stale.
    if (row.audienceVersion !== input.version) restamp.push(profileId);
  }

  for (const row of input.stored) {
    if (row.exitedAt !== null) continue;
    if (input.desired.has(row.profileId)) continue;
    transitions.push({ kind: "exited", profileId: row.profileId, enteredAt: row.enteredAt });
  }

  return { transitions, restamp };
}
