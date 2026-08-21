/**
 * The merge-rate breaker.
 *
 * The failure mode it exists for is the classic identity-graph incident:
 * one promiscuous identifier — a kiosk device, `customer_id: "guest"`, a
 * bot's shared anonymous id — chain-merges thousands of profiles into a
 * single mega-profile. The identifier denylist
 * (`@polaris/identity-rules`) is the first guard and refuses the value;
 * this is the second and refuses the RATE, because a denylist only
 * catches values somebody already knew about.
 *
 * A tripped breaker does not drop the event. The event still resolves to
 * the winner and keeps flowing; what stops is the graph growing. That
 * asymmetry is deliberate — a merge storm is an operator problem, and
 * halting a project's pipeline over it would turn a data-quality
 * incident into an outage.
 *
 * Committed merges are NOT unwound when the breaker trips. Repair is a
 * rebuild under corrected policy; see `./unmerge.ts` for why there is no
 * inverse operation.
 */

/** The bounds this decision reads. A slice of the project's identity policy. */
export interface MergeRateBounds {
  readonly maxMergesPerWindow: number;
  readonly mergeWindowSeconds: number;
}

/** Why a merge did not happen, as the `identity.merge_suspended` fact reports it. */
export interface MergeSuspension {
  readonly profileId: string;
  /** Merges this profile absorbed inside the window, at the moment of refusal. */
  readonly mergeCount: number;
}

export type MergeRateVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly suspension: MergeSuspension };

/**
 * The instant the rate window opens, given "now".
 *
 * Exposed because the count is a query the caller runs against its own
 * store — the breaker decides, the storage port counts — and both halves
 * have to agree on where the window starts.
 */
export function mergeWindowStart(now: Date, bounds: MergeRateBounds): Date {
  return new Date(now.getTime() - bounds.mergeWindowSeconds * 1000);
}

/**
 * Decide whether the winner may absorb another merge.
 *
 * `recentMerges` is how many merges the winner has already absorbed
 * since `mergeWindowStart`. The comparison is `>=` because the bound is
 * a maximum: at exactly the limit the next merge is the one too many.
 */
export function evaluateMergeRate(input: {
  readonly winnerProfileId: string;
  readonly recentMerges: number;
  readonly bounds: MergeRateBounds;
}): MergeRateVerdict {
  if (input.recentMerges >= input.bounds.maxMergesPerWindow) {
    return {
      allowed: false,
      suspension: { profileId: input.winnerProfileId, mergeCount: input.recentMerges },
    };
  }
  return { allowed: true };
}
