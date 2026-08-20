/**
 * Consent helpers for destination normalization.
 *
 * The canonical envelope carries:
 *
 *   consent: {
 *     analytics?: boolean | null,
 *     marketing?: boolean | null,
 *     personalization?: boolean | null,
 *   }
 *
 * Per `docs/architecture/01-event-contract.md` ("Privacy and Consent"),
 * `consent` is informational metadata at the platform level. Destination
 * consumers may use it; the platform does not enforce.
 *
 * This module owns the **destination-side** semantics:
 *
 *   1. Each destination declares which consent dimensions it consumes.
 *      (Meta CAPI declares `marketing`; GA4 declares `analytics`;
 *      Braze typically declares `marketing` + `personalization`.)
 *
 *   2. `evaluateConsent` returns `granted` / `denied` based on the
 *      destination's declared `requiredConsent`.
 *
 *   3. The **absent-as-true** default is honored here (per
 *      `docs/architecture/06-destinations.md` "Consent default when
 *      absent"): when a consent flag is missing or `null`, the destination
 *      sees it as `true`. Producers opting into stricter consent signaling
 *      set the fields explicitly to `false`.
 *
 * The result feeds the top-level `normalizeForDestination`, which turns a
 * `denied` evaluation into a `{ kind: 'drop', reason: 'consent_not_granted' }`
 * outcome before any vendor mapping runs.
 */

/**
 * Canonical consent shape from the envelope. Mirrors
 * `@polaris/spec`'s `consentSchema` so the helper does not have
 * to import the Zod schema at runtime.
 */
export interface EnvelopeConsent {
  readonly analytics?: boolean | null | undefined;
  readonly marketing?: boolean | null | undefined;
  readonly personalization?: boolean | null | undefined;
}

/** A consent dimension name from the canonical envelope. */
export type ConsentDimension = "analytics" | "marketing" | "personalization";

/**
 * Destination-declared consent requirement. Each dimension may be:
 *
 *   - `true`      — destination requires the producer to grant this dimension
 *   - `false`     — destination explicitly does not require it (rare; use
 *                  `undefined` to mean "do not check this dimension")
 *   - omitted     — destination does not check this dimension
 *
 * A destination that declares `{ marketing: true }` requires the
 * envelope's `consent.marketing` to be `true` (or absent — absent-as-true).
 */
export type RequiredConsent = {
  readonly [K in ConsentDimension]?: boolean;
};

/** A single per-dimension consent evaluation. */
export interface ConsentDimensionResult {
  readonly dimension: ConsentDimension;
  readonly required: boolean;
  /** Granted value seen by the destination after absent-as-true defaulting. */
  readonly granted: boolean;
}

/** Outcome of `evaluateConsent`. */
export type ConsentEvaluation =
  | { readonly status: "granted"; readonly dimensions: readonly ConsentDimensionResult[] }
  | {
      readonly status: "denied";
      readonly dimensions: readonly ConsentDimensionResult[];
      /** The first dimension whose required value was not granted. */
      readonly deniedBy: ConsentDimension;
    };

/**
 * Evaluate whether the envelope's consent satisfies the destination's
 * declared `requiredConsent`. Absent / null consent fields are treated as
 * `true` (absent-as-true default).
 *
 * The evaluation order is stable (`analytics`, `marketing`, `personalization`)
 * so the `deniedBy` field is deterministic — useful for label-stable
 * metrics on dropped events.
 */
export function evaluateConsent(
  envelopeConsent: EnvelopeConsent | undefined | null,
  requiredConsent: RequiredConsent,
): ConsentEvaluation {
  const dimensions: ConsentDimensionResult[] = [];
  let firstDenial: ConsentDimension | undefined;

  for (const dim of CONSENT_DIMENSIONS) {
    const required = requiredConsent[dim];
    if (required !== true) continue;
    const granted = readConsentDimension(envelopeConsent, dim);
    dimensions.push({ dimension: dim, required: true, granted });
    if (!granted && firstDenial === undefined) firstDenial = dim;
  }

  if (firstDenial !== undefined) {
    return { status: "denied", dimensions, deniedBy: firstDenial };
  }
  return { status: "granted", dimensions };
}

/**
 * Stable order used by `evaluateConsent`. Exposed for tests and future
 * vendor-slot helpers that need a canonical iteration order.
 */
export const CONSENT_DIMENSIONS: readonly ConsentDimension[] = [
  "analytics",
  "marketing",
  "personalization",
] as const;

function readConsentDimension(
  consent: EnvelopeConsent | undefined | null,
  dimension: ConsentDimension,
): boolean {
  if (consent === undefined || consent === null) return true;
  const value = consent[dimension];
  if (value === undefined || value === null) return true;
  return value === true;
}
