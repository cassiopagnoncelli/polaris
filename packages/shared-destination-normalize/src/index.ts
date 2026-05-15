/**
 * `@polaris/shared-destination-normalize` — vendor-agnostic normalization
 * primitives shared by every Polaris destination consumer.
 *
 * Per `docs/architecture/06-destinations.md`, every destination consumer
 * runs three stages:
 *
 *   NORMALIZE -> MAP -> DELIVER
 *
 * This package owns the destination-agnostic part of NORMALIZE. Each
 * consumer composes its own `normalize/` directory on top, adding vendor-
 * specific rules. Mappers (in `consumers/<vendor>/v<n>/mappers/`) see
 * only the normalized intermediate produced here; they never reach back
 * into the raw canonical envelope.
 *
 * The public API:
 *
 *   - `normalizeForDestination(envelope, options)`  the main entry point
 *   - `applySecondPassRedactions(envelope, override?)`  defensive
 *                                                       policy second-pass
 *   - `pickBestIdentity(identity)`             best-available identity
 *   - `prepareIdentity(input, hashing?)`       hash + canonicalize identity
 *   - `flattenContext(envelopeContext)`        nested → flat context
 *   - `hashEmailLower(email)`                  canonical email hash
 *   - `hashPhoneE164(phone)`                   canonical phone hash
 *   - `hashExternalId(id)`                     external-id hash
 *   - `sha256Hex(input)`                       raw SHA-256 wrapper
 *   - `minorToMajor` / `majorToMinor` / `exponentForCurrency`
 *                                              currency unit conversion
 *   - `isoToEpochMs` / `isoToEpochSeconds` / `isoToEpochMicros`
 *                                              timestamp conversion
 *   - `evaluateConsent(envelopeConsent, required)`
 *                                              destination consent gate
 *   - `DROP_REASONS` + closed-set types        delivery outcome vocabulary
 *
 * Exports are named only — there is no default export. This keeps the
 * package's public surface auditable and lets the OpenAPI/CLI inspection
 * tooling enumerate the helpers programmatically.
 */

// ---- Consent -------------------------------------------------------------
export {
  CONSENT_DIMENSIONS,
  type ConsentDimension,
  type ConsentDimensionResult,
  type ConsentEvaluation,
  type EnvelopeConsent,
  evaluateConsent,
  type RequiredConsent,
} from "./consent.js";
// ---- Context flattening --------------------------------------------------
export {
  type EnvelopeCampaignContext,
  type EnvelopeContextInput,
  type EnvelopePageContext,
  type FlatContext,
  flattenContext,
} from "./context.js";
// ---- Currency conversion -------------------------------------------------
export {
  CURRENCY_EXPONENTS,
  DEFAULT_CURRENCY_EXPONENT,
  exponentForCurrency,
  majorToMinor,
  minorToMajor,
} from "./currency.js";
export { canonicalizeEmail, hashEmailLower } from "./email.js";
export { canonicalizeExternalId, hashExternalId } from "./external-id.js";
// ---- Hashing primitives --------------------------------------------------
export { sha256Hex } from "./hashing.js";
// ---- Identity helpers ----------------------------------------------------
export {
  type BestIdentity,
  type BestIdentityKind,
  type IdentityHashingOptions,
  type PreparedIdentity,
  pickBestIdentity,
  prepareIdentity,
  type RawIdentityInput,
} from "./identity.js";
// ---- Public entry point ---------------------------------------------------
export {
  applySecondPassRedactions,
  DROP_REASONS,
  type DropOutcome,
  type DropReason,
  type NormalizableEnvelope,
  type NormalizedEvent,
  type NormalizedOutcome,
  type NormalizeOptions,
  type NormalizeOutcome,
  normalizeForDestination,
  type SecondPassRedactionOutcome,
} from "./normalize.js";
export { hashPhoneE164, requireE164 } from "./phone.js";

// ---- Timestamp conversion ------------------------------------------------
export { isoToEpochMicros, isoToEpochMs, isoToEpochSeconds } from "./timestamp.js";
