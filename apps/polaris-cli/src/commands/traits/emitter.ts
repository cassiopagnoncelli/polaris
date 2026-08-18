/**
 * Publishing what a traits run concluded onto `profile.events`.
 *
 * Until this existed the runner LOGGED its two events, which meant computed
 * traits reached an operator's log file and never the spine — so
 * `polaris.profiles` in ClickHouse, whose entire premise is that stream
 * being trait history, was fed only by the identity stage. The card that
 * built that table motivated this one.
 *
 * ## Event ids are derived, not minted
 *
 * A traits run has no source event to derive from — it is a scheduled
 * computation, not a reaction. So the id derives from `(runId, profileId)`,
 * which makes it deterministic per run: re-running the same run id produces
 * the same ids and ClickHouse's ReplacingMergeTree collapses the duplicates
 * instead of double-counting a nightly job that was restarted.
 *
 * A NEW run id produces new ids, which is also right — that run genuinely
 * observed different values.
 *
 * ## `occurred_at` is the run's clock
 *
 * There is no producer event whose time this fact is "about". The
 * computation happened now, and stamping anything else would put a trait
 * change on a timeline it did not happen on.
 */

import type { TraitEmitter } from "@polaris/processor-traits-v1";
import { deriveEventId } from "@polaris/shared-processor";
import {
  type PolarisProducer,
  STREAM_FAMILY_PROFILE_EVENTS,
  type SyncIsolationLookup,
} from "@polaris/shared-transport";

const PROCESSOR_NAME = "traits";
const PROCESSOR_VERSION = "v1";

export interface TraitEventEmitterDeps {
  readonly producer: PolarisProducer;
  readonly isolation: SyncIsolationLookup;
  readonly now: () => Date;
}

export function createTraitEventEmitter(deps: TraitEventEmitterDeps): TraitEmitter {
  const envelope = (input: {
    readonly event: string;
    readonly schemaVersion: number;
    readonly projectId: string;
    readonly environment: string;
    readonly slot: string;
    readonly derivedFrom: string;
    readonly properties: Record<string, unknown>;
    /** Omitted by `trait.computed`, which is about a definition, not a person. */
    readonly profileId?: string;
  }): Record<string, unknown> => {
    const at = deps.now().toISOString();
    return {
      event_id: deriveEventId({
        processor: PROCESSOR_NAME,
        sourceEventId: input.derivedFrom,
        slot: input.slot,
      }),
      event: input.event,
      schema_version: input.schemaVersion,
      project_id: input.projectId,
      environment: input.environment,
      // Both the run's clock: this fact is not "about" an earlier event.
      occurred_at: at,
      ingested_at: at,
      source: { id: `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`, type: "internal" },
      // No identity block. A computed trait belongs to a PROFILE, and
      // inventing an anonymous_id or customer_id here would claim the run
      // saw an identifier it never touched.
      identity: {},
      context: {},
      // The profile block IS how an envelope names its person, and this
      // omitted it until 2026-08-18 -- the reasoning above was right about
      // `identity` and then quietly treated `profile` as the same kind of
      // claim. It is not: `identity` is what a source observed, `profile`
      // is what the platform resolved, and a `profile.updated` that names
      // no profile is not a partial envelope but a meaningless one.
      //
      // The cost was total and silent. `profile_events_queue` keys on this
      // column, the materialized view drops rows where it is empty, and
      // the properties copy the run also writes is read by nothing.
      ...(input.profileId === undefined ? {} : { profile: { profile_id: input.profileId } }),
      properties: input.properties,
    };
  };

  return {
    async profileUpdated(input): Promise<void> {
      await deps.producer.publishEvent({
        family: STREAM_FAMILY_PROFILE_EVENTS,
        isolation: deps.isolation,
        event: envelope({
          event: "profile.updated",
          schemaVersion: 1,
          projectId: input.projectId,
          environment: input.environment,
          slot: "profile_updated",
          profileId: input.profileId,
          // Per profile per run, so a restarted run collapses rather than
          // emitting a second update for the same conclusion.
          derivedFrom: `${input.runId}:${input.profileId}`,
          properties: {
            profile_id: input.profileId,
            traits_version: input.traitsVersion,
            writer: "computed_traits",
            traits: input.traits,
            removed_keys: input.removedKeys.length > 0 ? [...input.removedKeys] : null,
            source_event_id: null,
            run_id: input.runId,
          },
        }) as never,
      });
    },

    async traitComputed(input): Promise<void> {
      await deps.producer.publishEvent({
        family: STREAM_FAMILY_PROFILE_EVENTS,
        isolation: deps.isolation,
        event: envelope({
          event: "trait.computed",
          schemaVersion: 1,
          projectId: input.projectId,
          environment: input.environment,
          slot: "trait_computed",
          // Per trait per run — one event per definition, as the catalog
          // entry says.
          derivedFrom: `${input.runId}:${input.traitKey}`,
          properties: {
            trait_key: input.traitKey,
            computed_count: input.computedCount,
            changed_count: input.changedCount,
            removed_count: input.removedCount,
            duration_ms: input.durationMs,
            run_id: input.runId,
          },
        }) as never,
      });
    },
  };
}
