/**
 * Currency-unit conversion helpers for destination normalization.
 *
 * Polaris property authors choose how to express monetary values inside
 * `properties` (minor units vs decimal) — per
 * `docs/architecture/01-event-contract.md` ("Property-level style is
 * owner-defined"). Destinations must therefore convert to whichever form
 * the vendor consumes:
 *
 *   - Meta CAPI            major-unit decimal number with `currency` ISO 4217
 *   - TikTok Events        major-unit decimal number
 *   - GA4 purchase         major-unit decimal number
 *   - Reddit Conversions   major-unit decimal number
 *
 * Most internal events deliver `amount` as minor units (cents/centavos) so
 * the platform helpers focus on minor → major conversion. The reverse
 * helper exists for the few vendors that consume minor units directly.
 *
 * Currency-specific exponents (JPY = 0, BHD = 3, USD = 2) come from
 * ISO 4217. We carry an internal table for the most common currencies and
 * fall back to 2 when the currency code is unknown — the fallback is
 * documented in the helper so callers can override.
 */

/**
 * ISO 4217 exponent (decimal places) for currencies that diverge from the
 * 2-decimal default. The table is intentionally narrow: the long tail of
 * 3-decimal and 0-decimal currencies is rare in Polaris traffic and adding
 * an unknown currency code surfaces as a default-2 conversion rather than
 * a silent drop. Callers that need exhaustive coverage pass `exponent`
 * explicitly.
 *
 * Sources:
 *   - ISO 4217 Table A.1 (2015 edition)
 *   - CLDR currency data for cross-checking
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, 0 | 2 | 3 | 4>> = Object.freeze({
  // 0-decimal currencies
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // 3-decimal currencies
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // 4-decimal currencies (CLF, UYW)
  CLF: 4,
  UYW: 4,
});

/** Default exponent applied when a currency is not in the lookup table. */
export const DEFAULT_CURRENCY_EXPONENT = 2 as const;

/**
 * Return the ISO 4217 exponent for `currency` (case-insensitive). Falls
 * back to `DEFAULT_CURRENCY_EXPONENT` when unknown. The currency code is
 * not validated against ISO 4217 — that is the producer's responsibility
 * and is enforced (where it is enforced) by per-event property schemas.
 */
export function exponentForCurrency(currency: string): number {
  const upper = currency.trim().toUpperCase();
  return CURRENCY_EXPONENTS[upper] ?? DEFAULT_CURRENCY_EXPONENT;
}

/**
 * Convert a minor-unit integer amount to the major-unit decimal vendors
 * consume.
 *
 *   minorToMajor(12990, "BRL") === 129.9
 *   minorToMajor(50000, "JPY") === 50000   // 0-decimal currency
 *   minorToMajor(1000,  "BHD") === 1       // 3-decimal currency
 *
 * The result is a JavaScript number rounded to the currency's precision
 * (away-from-zero, so `12995/100` rounds to `129.95` not `129.9499...`).
 * Returns a `number` (not a string) because vendor APIs almost universally
 * deserialize a JSON number for amounts; consumers that need a string form
 * (e.g. for fixed-point invoice fields) format separately.
 *
 * @param minor   integer minor units (cents, centavos, fils)
 * @param currency ISO 4217 currency code (used only to look up the
 *                 exponent; not transformed in the result)
 * @param exponent optional override; defaults to `exponentForCurrency`
 */
export function minorToMajor(
  minor: number,
  currency: string,
  exponent: number = exponentForCurrency(currency),
): number {
  if (!Number.isFinite(minor) || !Number.isInteger(minor)) {
    throw new RangeError("minorToMajor: `minor` must be a finite integer");
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 8) {
    throw new RangeError("minorToMajor: `exponent` must be a non-negative integer (<= 8)");
  }
  if (exponent === 0) return minor;
  const divisor = 10 ** exponent;
  // Banker's-rounding style is overkill for currency conversion; vendors
  // accept the half-away-from-zero result the language naturally produces
  // here. We pin precision to the currency's exponent to avoid leaking
  // 64-bit float artefacts (e.g. `12990 / 100 -> 129.9` cleanly, but
  // `1 / 3` would round to the exponent).
  return Number((minor / divisor).toFixed(exponent));
}

/**
 * Convert a major-unit decimal amount to minor-unit integer.
 *
 *   majorToMinor(129.9, "BRL") === 12990
 *   majorToMinor(50000, "JPY") === 50000
 *
 * The conversion uses banker's-rounding-free `Math.round` and preserves the
 * sign. Use this for the small set of vendors that document a minor-unit
 * input (e.g. some Stripe-derived webhooks treat amounts as cents).
 */
export function majorToMinor(
  major: number,
  currency: string,
  exponent: number = exponentForCurrency(currency),
): number {
  if (!Number.isFinite(major)) {
    throw new RangeError("majorToMinor: `major` must be a finite number");
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 8) {
    throw new RangeError("majorToMinor: `exponent` must be a non-negative integer (<= 8)");
  }
  if (exponent === 0) return Math.round(major);
  const multiplier = 10 ** exponent;
  return Math.round(major * multiplier);
}
