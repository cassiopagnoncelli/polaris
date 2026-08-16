/**
 * Diffing a computed audience population against stored membership.
 *
 * The runner's semantics in one pure function.
 *
 * ## Transitions only
 *
 * A profile that qualified yesterday and qualifies today produces nothing.
 * This is the property the whole design rests on: `audience.entered` and
 * `audience.exited` are consumed as CHANGES, so a run over an unchanged
 * population must be silent. An audience of two million members re-emitting
 * nightly would be two million vendor writes a day describing nothing.
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
 * both v1 and v2 stays a member and has its stamp updated; it does not exit
 * v1 and enter v2.
 *
 * The alternative — scoping membership by version — was rejected because it
 * makes every predicate tweak, including a typo fix, exit and re-enter the
 * entire population. Downstream that is indistinguishable from every
 * customer genuinely leaving and rejoining overnight, and a suppression
 * audience would briefly show nobody suppressed. A version bump changes how
 * membership is DERIVED; it is not an event in any person's life.
 *
 * ## Re-entry is distinguishable from first entry
 *
 * An exited membership row survives its exit, so the runner knows a
 * returning profile has been here before and stamps `re_entry` on the
 * event. A destination running a welcome campaign needs that and cannot
 * derive it from the stream alone.
 */

/** A stored membership row, reduced to what the diff needs. */
export interface StoredMembership {
  readonly profileId: string;
  /** NULL while the profile is a member. */
  readonly exitedAt: Date | null;
  /** Start of the current or most recent membership. */
  readonly enteredAt: Date;
}

/** A profile joining the audience. */
export interface EnteredTransition {
  readonly kind: "entered";
  readonly profileId: string;
  /** True when a previous, exited membership exists for this profile. */
  readonly reEntry: boolean;
}

/** A profile leaving the audience. */
export interface ExitedTransition {
  readonly kind: "exited";
  readonly profileId: string;
  /** Start of the membership this exit closes. */
  readonly enteredAt: Date;
}

export type AudienceTransition = EnteredTransition | ExitedTransition;

export interface AudienceDiff {
  readonly transitions: readonly AudienceTransition[];
  /**
   * Profiles that stayed members and whose stored `audience_version` is
   * stale. They get a stamp update and NO event — the membership did not
   * change, only the definition that last confirmed it.
   */
  readonly restamp: readonly string[];
}

export interface DiffAudienceInput {
  /** Profiles the definition says are members right now. */
  readonly desired: Iterable<string>;
  /** Every stored row for this audience, open and closed. */
  readonly stored: readonly StoredMembership[];
  /** Version of the definition that produced `desired`. */
  readonly version: number;
  /** Stored version per profile, for the restamp decision. */
  readonly storedVersions: ReadonlyMap<string, number>;
}

export function diffAudience(input: DiffAudienceInput): AudienceDiff {
  const desired = new Set(input.desired);
  const storedBy = new Map(input.stored.map((row) => [row.profileId, row]));

  const transitions: AudienceTransition[] = [];
  const restamp: string[] = [];

  for (const profileId of desired) {
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
    if (input.storedVersions.get(profileId) !== input.version) {
      restamp.push(profileId);
    }
  }

  for (const row of input.stored) {
    if (row.exitedAt !== null) continue;
    if (desired.has(row.profileId)) continue;
    transitions.push({ kind: "exited", profileId: row.profileId, enteredAt: row.enteredAt });
  }

  return { transitions, restamp };
}
