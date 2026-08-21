/**
 * The trait model: what a profile knows about a person, and who may
 * write it.
 *
 * Traits are last-write-wins per key, and "last" means the order in
 * which serialized transactions committed on the profile row — not
 * arrival order at the broker, and not the clock. That is only
 * explainable while the writer set stays small, which is why the
 * identify family is a closed list rather than a predicate.
 */

import type { IdentityEnvelope, IdentityPolicy } from "@polaris/identity-rules";

/**
 * Identify-family events are the only ones whose properties may patch
 * profile traits.
 *
 * Restricting the writer set is what keeps last-write-wins explainable:
 * all events for a given customer serialize on one partition, so a
 * single serialized writer per person means the final trait value is a
 * function of arrival order and nothing else. Letting any `track()` push
 * traits would reintroduce the ambiguity from several directions at
 * once.
 */
const IDENTIFY_FAMILY_EVENTS = ["user.identified"] as const;

function isIdentifyFamily(event: IdentityEnvelope): boolean {
  return (IDENTIFY_FAMILY_EVENTS as readonly string[]).includes(event.event);
}

/**
 * Traits to merge-patch from an identify-family event.
 *
 * Returns `null` when the snapshot exceeds the size guard: the event
 * still resolves and still binds identifiers, it just does not carry its
 * traits into the store. Dropping the event instead would lose an
 * identity link over a payload-size problem.
 */
export function extractTraits(
  event: IdentityEnvelope,
  policy: IdentityPolicy,
): { readonly traits: Record<string, unknown> | null; readonly overCap: boolean } {
  if (!isIdentifyFamily(event)) return { traits: null, overCap: false };
  const properties = event.properties ?? {};
  if (Object.keys(properties).length === 0) return { traits: null, overCap: false };

  const encoded = Buffer.byteLength(JSON.stringify(properties), "utf8");
  if (encoded > policy.maxTraitsBytes) {
    return { traits: null, overCap: true };
  }
  return { traits: { ...properties }, overCap: false };
}

/** A profile's trait state, before or after a patch. */
export interface TraitState {
  readonly traits: Record<string, unknown>;
  readonly traitsVersion: number;
}

export interface TraitPatch extends TraitState {
  /** False when `patch` was null — nothing changed, and the version holds. */
  readonly patched: boolean;
}

/**
 * Merge-patch traits, per key, bumping the version only on a real write.
 *
 * The version is what downstream readers order snapshots by, so bumping
 * it on a no-op patch would advertise a change that did not happen and
 * make an unchanged profile look newer than one that was actually
 * edited.
 */
export function applyTraitPatch(
  current: TraitState,
  patch: Record<string, unknown> | null,
): TraitPatch {
  if (patch === null) {
    return { traits: current.traits, traitsVersion: current.traitsVersion, patched: false };
  }
  return {
    traits: { ...current.traits, ...patch },
    traitsVersion: current.traitsVersion + 1,
    patched: true,
  };
}
