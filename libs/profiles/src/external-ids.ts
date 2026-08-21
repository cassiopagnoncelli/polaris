/**
 * The profile's external ids: the identifier values that resolve to it.
 *
 * A profile has no natural key. What it has is a set of bindings —
 * `(kind, value) -> profile_id` — and every one of them is an id some
 * external system already uses for that person. The binding set IS the
 * identity graph's resolved state; `identity_links` is its
 * justification.
 */

import type { StrongIdentityKind } from "@polaris/identity-rules";

/** One identifier the resolution bound, or re-saw already bound. */
export interface BoundIdentifier {
  readonly kind: StrongIdentityKind;
  readonly value: string;
  /** False when the identifier already pointed at this profile. */
  readonly newlyBound: boolean;
}

/**
 * The canonical customer id, picked from what actually BOUND.
 *
 * Never from the raw input, and the distinction is load-bearing: a
 * cap-refused `customer_id` must not become canonical, because its
 * identifier row resolves elsewhere (or will create a fresh profile on
 * the next lookup) and destinations key on this column. A profile
 * claiming a customer id whose binding does not point back at it is a
 * lie the whole delivery path would repeat.
 */
export function pickCanonicalCustomerId(
  identifiers: readonly { readonly kind: StrongIdentityKind; readonly value: string }[],
): string | undefined {
  return identifiers.find((identifier) => identifier.kind === "customer_id")?.value;
}
