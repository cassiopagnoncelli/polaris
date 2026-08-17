/**
 * Publishing audience transitions onto `profile.events`.
 *
 * Same family and the same derived-id discipline as the traits emitter,
 * for the same reasons — an audience run is a scheduled computation with
 * no source event, so ids derive from `(runId, audience, profileId)` and a
 * restarted run collapses in ClickHouse instead of double-counting.
 *
 * The audience key is part of the derivation, not just the profile: one
 * run can move the same profile in two different audiences, and an id
 * derived from the profile alone would make the second transition a
 * duplicate of the first and silently drop it.
 */

import type { AudienceEmitter } from "@polaris/processor-audiences-v1";
import { deriveEventId } from "@polaris/shared-processor";
import {
  type PolarisProducer,
  STREAM_FAMILY_PROFILE_EVENTS,
  type SyncIsolationLookup,
} from "@polaris/shared-transport";

const PROCESSOR_NAME = "audiences";
const PROCESSOR_VERSION = "v1";

/**
 * Resolves a profile's canonical customer id.
 *
 * A transition names a PROFILE, and a vendor keys on a CUSTOMER. Braze's
 * `external_id`, Meta's identifiers, every destination's notion of "who"
 * is the brand's own customer id — not Polaris's internal surrogate — so
 * the emitter looks it up rather than making the runner carry it.
 *
 * Kept on the emitter rather than widened onto `AudienceProfileStore`
 * because a projection-sourced audience gets its members from ClickHouse
 * and never touches that store. One seam, both paths.
 */
export type AudienceIdentityLookup = (input: {
  readonly projectId: string;
  readonly environment: string;
  readonly profileId: string;
}) => Promise<string | null>;

export interface AudienceEventEmitterDeps {
  readonly producer: PolarisProducer;
  readonly isolation: SyncIsolationLookup;
  readonly now: () => Date;
  /**
   * Optional. Absent, transitions carry `profile_id` only — still a valid
   * identity to `normalizeForDestination`, which ranks it second, but one
   * no destination keys on. So the transition reaches the warehouse and
   * is SKIPPED at the vendor, which is the honest outcome for a profile
   * whose customer id nobody knows.
   */
  readonly identities?: AudienceIdentityLookup | undefined;
}

export function createAudienceEventEmitter(deps: AudienceEventEmitterDeps): AudienceEmitter {
  /**
   * One lookup per distinct profile per run, not per transition.
   *
   * A run over five audiences moves the same profile up to five times,
   * and the canonical id cannot change mid-run — the resolver is paused
   * for nothing here, but a merge landing between two transitions would
   * repoint the profile, and using one answer for the whole run is the
   * behaviour that keeps a single run internally consistent. The memo is
   * per emitter, so it dies with the invocation.
   */
  const canonicalIds = new Map<string, Promise<string | null>>();
  const canonicalIdFor = async (input: {
    projectId: string;
    environment: string;
    profileId: string;
  }): Promise<string | null> => {
    if (deps.identities === undefined) return null;
    const key = `${input.projectId}\u0000${input.environment}\u0000${input.profileId}`;
    const memoized = canonicalIds.get(key);
    if (memoized !== undefined) return memoized;
    // Stored before awaiting so two transitions for one profile share the
    // in-flight promise rather than racing two queries.
    const pending = deps.identities(input).catch(() => null);
    canonicalIds.set(key, pending);
    return pending;
  };

  const envelope = (input: {
    readonly event: string;
    readonly projectId: string;
    readonly environment: string;
    readonly slot: string;
    readonly derivedFrom: string;
    readonly profileId: string;
    readonly canonicalCustomerId: string | null;
    readonly properties: Record<string, unknown>;
  }): Record<string, unknown> => {
    const at = deps.now().toISOString();
    return {
      event_id: deriveEventId({
        processor: PROCESSOR_NAME,
        sourceEventId: input.derivedFrom,
        slot: input.slot,
      }),
      event: input.event,
      schema_version: 1,
      project_id: input.projectId,
      environment: input.environment,
      // Both the run's clock: a transition is not "about" an earlier event.
      occurred_at: at,
      ingested_at: at,
      source: { id: `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`, type: "internal" },
      // No identity block, and deliberately: inventing one would claim
      // the run saw an identifier it never touched.
      identity: {},
      // The PROFILE block instead — the envelope's designated slot for
      // exactly this, and what makes a transition deliverable. It is not
      // an invented identity: membership genuinely belongs to a profile,
      // and `normalizeForDestination` already reads its
      // `canonical_customer_id` and `profile_id` when picking the best
      // available identity. Without it every transition drops at
      // `no_usable_identity` before any mapper runs.
      profile: {
        profile_id: input.profileId,
        canonical_customer_id: input.canonicalCustomerId,
      },
      context: {},
      properties: input.properties,
    };
  };

  return {
    async entered(input): Promise<void> {
      const canonicalCustomerId = await canonicalIdFor({
        projectId: input.projectId,
        environment: input.environment,
        profileId: input.profileId,
      });
      await deps.producer.publishEvent({
        family: STREAM_FAMILY_PROFILE_EVENTS,
        isolation: deps.isolation,
        event: envelope({
          event: "audience.entered",
          projectId: input.projectId,
          environment: input.environment,
          slot: "audience_entered",
          derivedFrom: `${input.runId}:${input.audience}:${input.profileId}`,
          profileId: input.profileId,
          canonicalCustomerId,
          properties: {
            audience: input.audience,
            audience_version: input.audienceVersion,
            profile_id: input.profileId,
            re_entry: input.reEntry,
            run_id: input.runId,
          },
        }) as never,
      });
    },

    async exited(input): Promise<void> {
      const canonicalCustomerId = await canonicalIdFor({
        projectId: input.projectId,
        environment: input.environment,
        profileId: input.profileId,
      });
      await deps.producer.publishEvent({
        family: STREAM_FAMILY_PROFILE_EVENTS,
        isolation: deps.isolation,
        event: envelope({
          event: "audience.exited",
          projectId: input.projectId,
          environment: input.environment,
          slot: "audience_exited",
          derivedFrom: `${input.runId}:${input.audience}:${input.profileId}`,
          profileId: input.profileId,
          canonicalCustomerId,
          properties: {
            audience: input.audience,
            audience_version: input.audienceVersion,
            profile_id: input.profileId,
            entered_at: input.enteredAt.toISOString(),
            run_id: input.runId,
          },
        }) as never,
      });
    },
  };
}
