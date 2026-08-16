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

export interface AudienceEventEmitterDeps {
  readonly producer: PolarisProducer;
  readonly isolation: SyncIsolationLookup;
  readonly now: () => Date;
}

export function createAudienceEventEmitter(deps: AudienceEventEmitterDeps): AudienceEmitter {
  const envelope = (input: {
    readonly event: string;
    readonly projectId: string;
    readonly environment: string;
    readonly slot: string;
    readonly derivedFrom: string;
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
      // No identity block. Membership belongs to a PROFILE, which the
      // properties name; inventing an identity would claim the run saw an
      // identifier it never touched.
      identity: {},
      context: {},
      properties: input.properties,
    };
  };

  return {
    async entered(input): Promise<void> {
      await deps.producer.publishEvent({
        family: STREAM_FAMILY_PROFILE_EVENTS,
        isolation: deps.isolation,
        event: envelope({
          event: "audience.entered",
          projectId: input.projectId,
          environment: input.environment,
          slot: "audience_entered",
          derivedFrom: `${input.runId}:${input.audience}:${input.profileId}`,
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
      await deps.producer.publishEvent({
        family: STREAM_FAMILY_PROFILE_EVENTS,
        isolation: deps.isolation,
        event: envelope({
          event: "audience.exited",
          projectId: input.projectId,
          environment: input.environment,
          slot: "audience_exited",
          derivedFrom: `${input.runId}:${input.audience}:${input.profileId}`,
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
