/**
 * `@polaris/engage-activation` public surface.
 *
 * The membership-delta contract, and the sink port that consumes it.
 * Types only — see `types.ts` for why there is no runtime here yet.
 */

export type {
  ActivationOutcome,
  ActivationSink,
  AudienceKind,
  AudienceRef,
  EnteredDelta,
  ExitedDelta,
  MembershipChange,
  MembershipDelta,
  MembershipDeltaBatch,
} from "./types.js";
