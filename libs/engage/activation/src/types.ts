/**
 * The membership-delta contract.
 *
 * Interfaces and nothing else. There is no runtime here yet, on purpose:
 * ADR-0007 lists `libs/engage/activation` as a home the delivery roadmap
 * fills, and a home is declared before it is filled so that the card
 * filling it is a pure add rather than an add plus an argument about
 * layering. Q7COB gives it its first real file — the shape everything
 * downstream will agree on — and stops there.
 *
 * ## One shape, two producers
 *
 * Two things compute audience membership and neither knows about the
 * other. `async/computation/audiences/v1` evaluates a predicate over
 * traits, or a sanctioned projection, and produces the entered/exited
 * signals `@polaris/engage-audiences` defines. `linked-audiences/v1`, when
 * it arrives, will compile a data-graph predicate to warehouse SQL and
 * produce a population that way. What reaches a vendor is identical in
 * both cases — this profile joined, this profile left — and the reason to
 * write that down now is that the alternative is discovering it later,
 * once each side has invented its own shape and the sync stage has to
 * accept both.
 *
 * `test/contract.test.ts` holds the two together: it maps today's
 * `AudienceTransition` onto a `MembershipDelta`, so a change to the
 * signals that this contract cannot express fails there rather than in
 * whatever consumes it next.
 *
 * ## Why a delta and not a membership list
 *
 * Every vendor list operation is an add or a remove, and the computed
 * population is already diffed against stored membership before anything
 * leaves the platform — an audience of two million members re-declared
 * nightly would be two million vendor writes describing nothing. So what
 * crosses this boundary is what CHANGED, and a sink that needs the whole
 * population rebuilds it from `audience_memberships` rather than asking
 * the stream to repeat itself.
 *
 * ## Why the delta carries its version, and what the version does NOT mean
 *
 * `audience_version` stamps the definition revision that produced this
 * delta, for answering "why did this profile join" months later. It is not
 * a membership scope: a profile that qualifies under v1 and v2 stays a
 * member across the bump and produces no delta at all. Anything reading
 * this contract that keys vendor state by `(audience, audience_version)`
 * has re-decided that, and would exit and re-enter a whole population on a
 * typo fix.
 */

/**
 * Which kind of audience produced a delta.
 *
 * Carried because the two have different failure modes and an operator
 * looking at a stalled sync needs to know which side to read — not because
 * a sink should behave differently. A sink that branches on this is
 * treating one contract as two.
 */
export type AudienceKind = "computed" | "linked";

/** The audience a delta belongs to, in one scope. */
export interface AudienceRef {
  readonly projectId: string;
  readonly environment: string;
  readonly audience: string;
  readonly audienceVersion: number;
  readonly kind: AudienceKind;
}

/** A profile joining an audience. */
export interface EnteredDelta {
  readonly change: "entered";
  readonly profileId: string;
  /** True when a previous, exited membership exists for this profile. */
  readonly reEntry: boolean;
}

/** A profile leaving an audience. */
export interface ExitedDelta {
  readonly change: "exited";
  readonly profileId: string;
  /** Start of the membership this exit closes, for dwell time downstream. */
  readonly enteredAt: Date;
}

export type MembershipChange = EnteredDelta | ExitedDelta;

/** One membership change, addressed. */
export interface MembershipDelta extends AudienceRef {
  readonly change: MembershipChange;
  /** The run that produced it, so a vendor write traces to one pass. */
  readonly runId: string;
}

/**
 * Deltas for one audience, batched.
 *
 * Vendor list APIs are batch APIs — a per-profile call to a destination
 * that accepts a thousand ids at a time is a rate-limit incident wearing a
 * loop — so the contract is shaped for the call that will be made rather
 * than for the signal that arrived.
 */
export interface MembershipDeltaBatch extends AudienceRef {
  readonly changes: readonly MembershipChange[];
  readonly runId: string;
}

/** What a sink did with a batch. */
export interface ActivationOutcome {
  readonly applied: number;
  /** Changes the vendor refused, with the reason it gave. */
  readonly rejected: ReadonlyArray<{
    readonly profileId: string;
    readonly reason: string;
  }>;
}

/**
 * Where a batch goes.
 *
 * The port `async/activation/audience-sync` will implement over a
 * connector's list operations. It is declared here rather than there
 * because both audience kinds must write through one shape, and a port
 * defined inside one of its callers is a port with a preferred caller.
 */
export interface ActivationSink {
  apply(batch: MembershipDeltaBatch): Promise<ActivationOutcome>;
}
