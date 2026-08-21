/**
 * Un-merge is replay, not surgery.
 *
 * There is no "split this profile" operation and there deliberately is
 * not going to be one. Unpicking a merge in place means deciding which
 * of the survivor's identifiers, traits, sessions and attribution chains
 * belonged to which side, and every one of those answers would be a
 * guess. The profile store is derived state, so the honest repair is to
 * derive it again: pause the resolver for the project, truncate its
 * profile scope, replay `raw.events` under corrected policy, resume.
 * What comes out is what the current rules would have concluded all
 * along, which is the only available definition of "correct".
 *
 * This is the contract half of `polaris profiles rebuild`. The command
 * owns the operator surface — flags, confirmation, output, the job
 * record — and the ORDER below is the part that is identity semantics
 * rather than CLI: it is a property of what a merge is, and it would be
 * the same order if the rebuild were driven by an API or by a script.
 *
 * ## Three of the four orderings are wrong, and two of them quietly
 *
 * The resolver must be paused BEFORE the truncate, or live traffic
 * writes profiles into the scope being emptied and the rebuild races
 * itself. It must be resumed only AFTER the replay, or the same events
 * arrive twice — once from the replay and once from the live stream —
 * and the resolver's advisory locks serialise them into a merge nobody
 * asked for. Neither failure raises anything: both produce a rebuild
 * that reports success over a profile plane that is subtly not what the
 * rules say it should be.
 *
 * ## Depth is bounded by retention
 *
 * A replay reaches only as far back as `raw.events` is retained, so a
 * profile whose first sighting predates the window is rebuilt from its
 * visible history alone — a customer of five years can emerge with a
 * `first_seen_at` of ninety days ago. The bound is reported, never
 * hidden: an operator who rebuilds to fix an over-merge and silently
 * loses five years of lineage has been handed a worse problem than the
 * one they started with. R10's archive replay source is what lifts it.
 */

/** The rebuild's four steps, in the only order that is correct. */
export const REBUILD_STEPS = ["pause", "truncate", "replay", "resume"] as const;
export type RebuildStep = (typeof REBUILD_STEPS)[number];
