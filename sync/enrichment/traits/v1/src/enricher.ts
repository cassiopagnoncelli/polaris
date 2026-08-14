/**
 * The traits enricher: profile id → the latest traits snapshot.
 *
 * Fills `profile.traits` and `profile.traits_version` on an envelope the
 * identity stage already stamped with a `profile_id`. The snapshot is
 * "latest as of delivery" — a point-in-time copy, not a live view — and
 * `traits_version` is what makes a historical delivery explainable after
 * the profile has moved on: two events for the same person carrying
 * different trait values are not a contradiction if their versions
 * differ.
 *
 * ## Why an over-size snapshot becomes `null` rather than a drop
 *
 * A profile whose traits exceed the guard still gets its event
 * delivered, with `traits: null`. The alternatives are worse in both
 * directions: dropping the event loses a real fact over a payload-size
 * problem, and truncating the bag would hand destinations a snapshot
 * that looks complete and is not. `traits: null` is the same shape as
 * "not enriched yet" ON PURPOSE — a consumer must treat both as "I do
 * not have traits for this delivery", which is the only safe reading of
 * either.
 *
 * The guard is a SEMANTIC parameter: it changes emitted events, so it is
 * declared in the runtime's manifest with bounds, and a project may
 * narrow it. It is deliberately a separate bound from the identity
 * stage's `max_traits_bytes`, which limits what one `identify` call may
 * WRITE. This one limits what the spine will CARRY, and they answer to
 * different pressures — a profile can exceed this one after many small,
 * individually-legal writes.
 */

import type { ProfileReader, ProfileSnapshot } from "./reader.js";

/** This enricher's identity. Pinned by the runtime's manifest. */
export const ENRICHER_NAME = "sync-enrichment-traits" as const;
export const ENRICHER_VERSION = "v1" as const;
export const ENRICHER_IDENTITY = Object.freeze({
  name: ENRICHER_NAME,
  version: ENRICHER_VERSION,
});

/** Default byte ceiling for a stamped snapshot. Mirrors the manifest. */
export const DEFAULT_MAX_TRAITS_BYTES = 32_768;

/** What the enricher resolved, for the runtime's stamping and metrics. */
export interface TraitsOutcome {
  /** The snapshot to stamp, or `null` when there is none to carry. */
  readonly traits: Record<string, unknown> | null;
  /** The version that produced `traits`. Absent when no profile was read. */
  readonly traitsVersion: number | null;
  readonly kind:
    | "resolved" // a profile was read and its snapshot fits
    | "over_cap" // a profile was read; its snapshot exceeds the guard
    | "empty" // a profile was read and carries no traits yet
    | "missing" // no row bears that profile id
    | "unprofiled"; // the event carries no profile id at all
}

export interface TraitsEnricherOptions {
  readonly maxTraitsBytes?: number;
}

/**
 * Resolve the traits snapshot for one event.
 *
 * `profileId` is `null` for an event the identity stage could not
 * resolve to a person; the enricher returns `unprofiled` without
 * touching the database, because there is nothing to look up and a
 * query per unidentifiable event is pure load.
 */
export async function enrichTraits(
  input: {
    readonly profileId: string | null;
    readonly reader: ProfileReader;
  },
  options: TraitsEnricherOptions = {},
): Promise<TraitsOutcome> {
  if (input.profileId === null) {
    return { traits: null, traitsVersion: null, kind: "unprofiled" };
  }

  const snapshot = await input.reader.readProfile(input.profileId);
  if (snapshot === null) {
    return { traits: null, traitsVersion: null, kind: "missing" };
  }

  return classify(snapshot, options.maxTraitsBytes ?? DEFAULT_MAX_TRAITS_BYTES);
}

function classify(snapshot: ProfileSnapshot, maxBytes: number): TraitsOutcome {
  const keys = Object.keys(snapshot.traits);
  if (keys.length === 0) {
    // A real profile with nothing said about it yet. Distinct from
    // `missing` for metrics: one is normal early life, the other means
    // the spine is naming rows the store does not have.
    return { traits: {}, traitsVersion: snapshot.traitsVersion, kind: "empty" };
  }

  // Measured on the SERIALISED form, because that is what the guard is
  // protecting: the bytes this snapshot adds to every downstream copy of
  // the event.
  const encoded = Buffer.byteLength(JSON.stringify(snapshot.traits), "utf8");
  if (encoded > maxBytes) {
    // The version is still reported. It costs nothing, and it lets an
    // operator answer "which profile version was too large" from the
    // emitted event rather than by querying the store.
    return { traits: null, traitsVersion: snapshot.traitsVersion, kind: "over_cap" };
  }

  return { traits: snapshot.traits, traitsVersion: snapshot.traitsVersion, kind: "resolved" };
}
