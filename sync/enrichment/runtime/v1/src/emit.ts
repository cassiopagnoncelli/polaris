/**
 * The `resolved.events` envelope.
 *
 * This stage is a PASSTHROUGH with blocks filled in: the event that
 * leaves is the event that arrived, plus `profile.traits` /
 * `profile.traits_version` and the `enrichment` block. Everything else
 * is carried verbatim, and two fields in particular are load-bearing:
 *
 *   - `event_id` — the same fact keeps the same identity across all
 *     three spine families. A new id here would make `raw`, `identified`
 *     and `resolved` three different events in ClickHouse instead of
 *     three sightings of one, and no join would recover the link.
 *
 *   - `ingested_at` — when POLARIS received the fact, not when this
 *     stage touched it. Restamping would zero out every end-to-end lag
 *     metric (they measure ingest→now, so a fresh stamp reads as "no
 *     lag" precisely when the pipeline is slowest) and would change how
 *     `analytics_raw._version` dedupes the row against the legacy feed
 *     during the M3 dual-run.
 *
 * The stage emits no derived facts of its own. It has nothing to report
 * that the enriched event does not already carry — an enrichment is an
 * attribute of the event, not an event about the event.
 */

import { type CanonicalEnvelopeInput, stampProcessorMetadata } from "@polaris/pipeline";
import type { GeoBlock } from "@polaris/sync-enrichment-geoip-v1";

import { PROCESSOR_IDENTITY } from "./pins.js";

/**
 * The transport hands this stage `Record<string, unknown>` and the
 * ingester — not this stage — is authoritative on envelope validity, so
 * the cast to the canonical shape happens once, here, at the boundary.
 */
function asCanonical(envelope: Record<string, unknown>): CanonicalEnvelopeInput {
  return envelope as unknown as CanonicalEnvelopeInput;
}

function asRecord(envelope: unknown): Record<string, unknown> {
  return envelope as Record<string, unknown>;
}

export interface EnrichedBlocks {
  /** The snapshot to stamp, or `null` when there is none to carry. */
  readonly traits: Record<string, unknown> | null;
  /** Absent when no profile was read at all. */
  readonly traitsVersion: number | null;
  readonly geo: GeoBlock | null;
}

/**
 * Build the `resolved.events` envelope.
 *
 * `profile` is left exactly as the identity stage wrote it when the
 * event carries none — a `null` profile passes through `null`, and the
 * traits slots are simply not added. Writing `traits: null` onto an
 * absent profile block would mean inventing a profile object for an
 * event that has no person, which is a different claim entirely.
 */
export function buildResolvedEvent(
  source: Record<string, unknown>,
  blocks: EnrichedBlocks,
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

  const profile = source["profile"] as Record<string, unknown> | null | undefined;

  return {
    ...stamped,
    profile:
      profile === null || profile === undefined
        ? null
        : {
            ...profile,
            traits: blocks.traits,
            ...(blocks.traitsVersion !== null ? { traits_version: blocks.traitsVersion } : {}),
          },
    enrichment: { geo: blocks.geo },
  };
}
