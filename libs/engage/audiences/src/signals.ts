/**
 * The entered/exited signals an audience run produces.
 *
 * The vocabulary, and nothing that derives it. Which membership changes
 * count as signals is `diffAudience` in `evaluator.ts` — private, because
 * `planAudience` is the only route to the decision — and that is where the
 * three rules behind these shapes are written down: transitions only, a
 * version bump is not a re-entry, and a re-entry is distinguishable from a
 * first entry. `async/computation/audiences/v1` writes and publishes what
 * comes back.
 *
 * The types are separate from the derivation because they outlive it.
 * `libs/engage/activation` describes the membership deltas every audience
 * kind exits through in these terms, and linked audiences will produce the
 * same signals from a warehouse query rather than from this diff.
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
