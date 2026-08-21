/**
 * `@polaris/identity-merge` — what it means for two profiles to be one
 * person.
 *
 * One of the four modules ADR-0007 decomposes the identity subsystem
 * into. `@polaris/identity-graph` performs merges against a storage
 * port; this library decides them: who survives, when the breaker
 * refuses, what a refusal is called, and why a wrong merge is repaired
 * by rebuilding rather than by an inverse operation.
 */

export {
  evaluateMergeRate,
  type MergeRateBounds,
  type MergeRateVerdict,
  type MergeSuspension,
  mergeWindowStart,
} from "./breaker.js";
export type {
  LinkRejectionReason,
  MergeOutcome,
  RejectedIdentifier,
} from "./safeguards.js";
export { REBUILD_STEPS, type RebuildStep } from "./unmerge.js";
export {
  type MergeCandidate,
  type MergeSelection,
  selectMergeWinner,
} from "./winner.js";
