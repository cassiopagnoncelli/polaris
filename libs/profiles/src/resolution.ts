/**
 * What resolving an event against the profile store produces.
 *
 * The result is a single value rather than a set of side effects
 * because everything downstream reads it: the spine event's `profile`
 * block, the derived facts, the outcome metric, and the tests that hold
 * two store implementations to one contract. A caller that had to
 * re-query to learn what happened would be re-deriving a decision the
 * store already made, and the two answers could differ.
 */

import type { CollectedIdentifier, IdentityPolicy } from "@polaris/identity-rules";
import type { MergeOutcome, MergeSuspension, RejectedIdentifier } from "@polaris/identity-merge";

import type { BoundIdentifier } from "./external-ids.js";

/** What the resolution did, which decides which facts get emitted. */
export type ResolutionKind =
  | "created" // no identifier resolved: a new profile
  | "bound" // one profile resolved; zero or more identifiers newly bound
  | "merged" // two profiles resolved: they are one person
  | "unidentified"; // no strong identifiers survived collection

export interface ResolutionResult {
  readonly kind: ResolutionKind;
  readonly profileId: string | null;
  readonly canonicalCustomerId: string | null;
  readonly traitsVersion: number | null;
  readonly bound: readonly BoundIdentifier[];
  readonly merge: MergeOutcome | null;
  readonly rejected: readonly RejectedIdentifier[];
  /** Set when the merge-rate breaker refused a merge. */
  readonly mergeSuspended: MergeSuspension | null;
  /** True when this event patched traits. */
  readonly traitsPatched: boolean;
}

export interface ResolveInput {
  readonly projectId: string;
  readonly environment: string;
  readonly identifiers: readonly CollectedIdentifier[];
  readonly traits: Record<string, unknown> | null;
  readonly sourceEventId: string;
  readonly sourceEventName: string;
  readonly runId: string | null;
  readonly policy: IdentityPolicy;
  readonly now: Date;
}

/**
 * The profile store, as the identity stage asks for it.
 *
 * One method, because the whole decision is one transaction: an
 * interface offering `findProfile` and `createProfile` separately would
 * invite a caller to interleave them and lose the atomicity the merge
 * path depends on.
 */
export interface ProfileRepository {
  resolveProfile(input: ResolveInput): Promise<ResolutionResult>;
}

/**
 * The result for an event with no resolvable identity.
 *
 * Stamped `profile: null` and forwarded rather than dropped — the spine
 * never drops an event for being unidentifiable, because destinations
 * already classify that per instance and dropping here would lose the
 * event for analytics too.
 */
export function unidentifiedResolution(): ResolutionResult {
  return {
    kind: "unidentified",
    profileId: null,
    canonicalCustomerId: null,
    traitsVersion: null,
    bound: [],
    merge: null,
    rejected: [],
    mergeSuspended: null,
    traitsPatched: false,
  };
}
