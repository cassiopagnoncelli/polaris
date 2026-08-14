/**
 * Envelope builders for the identity stage.
 *
 * Two kinds of output, and the distinction matters:
 *
 *   - the SPINE event is the SAME fact passing through. It keeps its
 *     `event_id`, `event`, `schema_version`, `occurred_at` and — this is
 *     the one people get wrong — its `ingested_at`. Restamping
 *     `ingested_at` on a passthrough would corrupt end-to-end lag metrics
 *     (they measure ingest→now) and, because `analytics_raw._version`
 *     falls back to `ingested_at` milliseconds, would silently change how
 *     ClickHouse dedupes the row against the legacy feed during the M3
 *     dual-run.
 *
 *   - DERIVED facts (`identity.*`, `profile.updated`) are new events with
 *     new deterministic ids, built the way every other processor builds
 *     them.
 */

import {
  type CanonicalEnvelopeInput,
  deriveEventId,
  stampProcessorMetadata,
} from "@polaris/shared-processor";

import type { BoundIdentifier, MergeOutcome, RejectedIdentifier } from "./repository.js";

/**
 * The stage handles envelopes as loose records because the transport
 * hands it `Record<string, unknown>` and the ingester — not this stage —
 * is authoritative on envelope validity (processors do a shallow
 * structural check, they do not re-run Zod on the hot path). The stamp
 * helper wants the canonical shape, so the cast happens here, once, at
 * the boundary rather than scattered through the builders.
 */
function asCanonical(envelope: Record<string, unknown>): CanonicalEnvelopeInput {
  return envelope as unknown as CanonicalEnvelopeInput;
}

function asRecord(envelope: unknown): Record<string, unknown> {
  return envelope as Record<string, unknown>;
}

export const PROCESSOR_NAME = "sync-identity-resolver";
export const PROCESSOR_VERSION = "v1";
export const PROCESSOR_IDENTITY = {
  name: PROCESSOR_NAME,
  version: PROCESSOR_VERSION,
} as const;

const INTERNAL_SOURCE = { type: "internal", id: PROCESSOR_NAME } as const;

export interface ProfileStamp {
  readonly profile_id: string;
  readonly canonical_customer_id: string | null;
}

/**
 * Build the spine event: the source envelope with the `profile` block
 * stamped on.
 *
 * `profile` is `null` for an event with no resolvable identity — the
 * spine forwards it rather than dropping it, because "we could not
 * identify this" is a fact the destinations already know how to classify
 * (`dropped_no_identity`), and dropping it here would lose the event for
 * analytics too.
 */
export function buildSpineEvent(
  source: Record<string, unknown>,
  profile: ProfileStamp | null,
  runId: string | null,
  now: Date,
): Record<string, unknown> {
  const stamped = asRecord(
    stampProcessorMetadata(asCanonical(source), {
      identity: PROCESSOR_IDENTITY,
      ...(runId !== null ? { run_id: runId } : {}),
      now: () => now,
    }),
  );

  return {
    ...stamped,
    profile:
      profile === null
        ? null
        : {
            profile_id: profile.profile_id,
            canonical_customer_id: profile.canonical_customer_id,
          },
  };
}

interface DerivedEnvelopeInput {
  readonly source: Record<string, unknown>;
  readonly event: string;
  readonly schemaVersion: number;
  readonly slot: string;
  readonly properties: Record<string, unknown>;
  readonly runId: string | null;
  readonly now: Date;
}

/**
 * Build a derived fact.
 *
 * `deriveEventId` is UUIDv5 over (processor, source event id, slot), so a
 * replay of the same source event produces the same id and ClickHouse's
 * ReplacingMergeTree collapses the pair instead of double-counting.
 */
function buildDerivedEvent(input: DerivedEnvelopeInput): Record<string, unknown> {
  const sourceEventId = String(input.source["event_id"] ?? "");
  const derivedId = deriveEventId({
    processor: PROCESSOR_NAME,
    sourceEventId,
    slot: input.slot,
  });

  const envelope: Record<string, unknown> = {
    event_id: derivedId,
    event: input.event,
    schema_version: input.schemaVersion,
    project_id: input.source["project_id"],
    environment: input.source["environment"],
    // Mirrors the source: the fact is ABOUT an event that occurred then.
    occurred_at: input.source["occurred_at"],
    // Stamped fresh: this is a new fact, and Polaris received it now.
    ingested_at: input.now.toISOString(),
    source: INTERNAL_SOURCE,
    // Copied, never invented — the derived fact belongs to the same
    // person as the event that produced it.
    identity: input.source["identity"],
    context: {},
    properties: input.properties,
  };

  return asRecord(
    stampProcessorMetadata(asCanonical(envelope), {
      identity: PROCESSOR_IDENTITY,
      ...(input.runId !== null ? { run_id: input.runId } : {}),
      now: () => input.now,
    }),
  );
}

export function buildIdentityLinkedEvent(args: {
  readonly source: Record<string, unknown>;
  readonly profileId: string;
  readonly identifier: BoundIdentifier;
  readonly profileCreated: boolean;
  readonly linkId: string;
  readonly runId: string | null;
  readonly now: Date;
}): Record<string, unknown> {
  return buildDerivedEvent({
    source: args.source,
    event: "identity.linked",
    schemaVersion: 2,
    // One slot per bound identifier, so binding two identifiers on one
    // event yields two stable, distinct derived ids.
    slot: `linked:${args.identifier.kind}:${args.identifier.value}`,
    properties: {
      profile_id: args.profileId,
      identifier: `${args.identifier.kind}:${args.identifier.value}`,
      profile_created: args.profileCreated,
      link_id: args.linkId,
      evidence_type: "explicit_overlap",
      source_event_id: String(args.source["event_id"] ?? ""),
      run_id: args.runId ?? "unknown",
    },
    runId: args.runId,
    now: args.now,
  });
}

export function buildIdentityMergedEvent(args: {
  readonly source: Record<string, unknown>;
  readonly merge: MergeOutcome;
  readonly runId: string | null;
  readonly now: Date;
}): Record<string, unknown> {
  return buildDerivedEvent({
    source: args.source,
    event: "identity.merged",
    schemaVersion: 2,
    slot: "merged",
    properties: {
      winner_profile_id: args.merge.winnerProfileId,
      loser_profile_id: args.merge.loserProfileId,
      merge_id: args.merge.mergeId,
      identifiers_moved: args.merge.identifiersMoved,
      source_event_id: String(args.source["event_id"] ?? ""),
      reason: "identifiers co-occurred on one event",
      run_id: args.runId ?? "unknown",
    },
    runId: args.runId,
    now: args.now,
  });
}

export function buildLinkRejectedEvent(args: {
  readonly source: Record<string, unknown>;
  readonly profileId: string | null;
  readonly rejected: RejectedIdentifier;
  readonly runId: string | null;
  readonly now: Date;
}): Record<string, unknown> {
  return buildDerivedEvent({
    source: args.source,
    event: "identity.link_rejected",
    schemaVersion: 1,
    slot: `rejected:${args.rejected.kind}:${args.rejected.value}`,
    properties: {
      profile_id: args.profileId,
      identifier: `${args.rejected.kind}:${args.rejected.value}`,
      reason: args.rejected.reason,
      ...(args.rejected.existingBindingCount !== undefined
        ? { existing_binding_count: args.rejected.existingBindingCount }
        : {}),
      source_event_id: String(args.source["event_id"] ?? ""),
      run_id: args.runId ?? "unknown",
    },
    runId: args.runId,
    now: args.now,
  });
}

export function buildMergeSuspendedEvent(args: {
  readonly source: Record<string, unknown>;
  readonly profileId: string;
  readonly mergeCount: number;
  readonly mergeLimit: number;
  readonly windowSeconds: number;
  readonly runId: string | null;
  readonly now: Date;
}): Record<string, unknown> {
  return buildDerivedEvent({
    source: args.source,
    event: "identity.merge_suspended",
    schemaVersion: 1,
    slot: "merge_suspended",
    properties: {
      profile_id: args.profileId,
      merge_count: args.mergeCount,
      merge_limit: args.mergeLimit,
      window_seconds: args.windowSeconds,
      source_event_id: String(args.source["event_id"] ?? ""),
      run_id: args.runId ?? "unknown",
    },
    runId: args.runId,
    now: args.now,
  });
}

export function buildProfileUpdatedEvent(args: {
  readonly source: Record<string, unknown>;
  readonly profileId: string;
  readonly traitsVersion: number;
  readonly traits: Record<string, unknown>;
  readonly runId: string | null;
  readonly now: Date;
}): Record<string, unknown> {
  return buildDerivedEvent({
    source: args.source,
    event: "profile.updated",
    schemaVersion: 1,
    slot: "profile_updated",
    properties: {
      profile_id: args.profileId,
      traits_version: args.traitsVersion,
      writer: "identity_stage",
      // Changed keys only — the full bag would multiply ClickHouse
      // storage by the trait count for a value one argMax away.
      traits: args.traits,
      source_event_id: String(args.source["event_id"] ?? ""),
      run_id: args.runId ?? "unknown",
    },
    runId: args.runId,
    now: args.now,
  });
}
