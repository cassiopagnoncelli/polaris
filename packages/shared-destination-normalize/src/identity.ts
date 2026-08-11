/**
 * Identity preparation for destination normalization.
 *
 * Per `docs/architecture/06-destinations.md`, destinations require the
 * canonical identity tuple in both raw and hashed forms:
 *
 *   { user_id?, anonymous_id?, email_sha256?, phone_sha256? }
 *
 * SHA-256 hashing happens **here**, not in the vendor mapper. The mapper
 * receives both the raw and hashed forms and picks whichever the vendor
 * consumes. This puts the canonical hashing rule in one place (the
 * email/phone helpers in this package) so a vendor-side bug cannot drift
 * from another vendor's hashing.
 *
 * "Best-available identity" mirrors the partition-key picker rule from
 * `@polaris/shared-transport/buildRawEventsPartitionKey`:
 *
 *   user_id > email_sha256 > phone_sha256 > anonymous_id
 *
 * Vendor mappers that need a single identity value (Meta's `external_id`
 * deduplication key, TikTok's `external_id`, Reddit's `external_id`) call
 * `pickBestIdentity` to get a stable choice.
 */

import { hashEmailLower } from "./email.js";
import { hashPhoneE164 } from "./phone.js";

/**
 * Raw identity inputs from the canonical envelope plus the producer-supplied
 * email / phone in `properties` (or `traits`). The destination consumer
 * pulls these out and hands them to `prepareIdentity`.
 *
 * Every field is optional. Empty strings, `null`, and `undefined` are
 * treated as missing.
 */
export interface RawIdentityInput {
  /** Producer-controlled stable user id (e.g. `customer_id`). */
  readonly user_id?: string | null | undefined;
  /** SDK-issued anonymous id (browser cookie / SDK-generated). */
  readonly anonymous_id?: string | null | undefined;
  /** Raw email (will be canonicalized + hashed). */
  readonly email?: string | null | undefined;
  /** Raw phone in strict E.164 (will be hashed). Refused if not E.164. */
  readonly phone?: string | null | undefined;
}

/** Per-destination toggles for which PII the normalizer should hash. */
export interface IdentityHashingOptions {
  /** Hash email if present. Default: `true`. */
  readonly email?: boolean;
  /** Hash phone if present. Default: `true`. */
  readonly phone?: boolean;
}

/**
 * Prepared identity surface handed to the vendor mapper. Both raw and
 * hashed forms are present where applicable; mappers choose per vendor.
 *
 * Hashed fields are populated only when `IdentityHashingOptions` enables
 * them AND a usable raw value was present. A `null` hashed slot means
 * "no usable raw value"; mapper code can rely on the field name to know
 * which producer-supplied data was absent.
 *
 * `phone_sha256` may be `null` when the producer supplied a non-E.164
 * phone — the hash is intentionally not computed in that case, and the
 * raw phone is preserved so a consumer-specific normalize stage can
 * attempt a country-aware reformat before re-hashing.
 */
export interface PreparedIdentity {
  readonly user_id: string | null;
  readonly anonymous_id: string | null;
  readonly email: string | null;
  readonly email_sha256: string | null;
  readonly phone: string | null;
  readonly phone_sha256: string | null;
}

/** Identifier the `pickBestIdentity` helper actually chose. */
export type BestIdentityKind = "user_id" | "email_sha256" | "phone_sha256" | "anonymous_id";

/** Result of `pickBestIdentity`. */
export interface BestIdentity {
  readonly kind: BestIdentityKind;
  readonly value: string;
}

/**
 * Canonicalize + (conditionally) hash the identity inputs. The result is
 * deterministic and stateless. No I/O, no logging.
 *
 * - `email` is lowercased + trimmed before hashing.
 * - `phone` must already be in E.164 (`+` + 7-15 digits). Non-E.164
 *   phones leave both `phone_sha256` populated as `null` and `phone`
 *   carrying the trimmed raw input — a downstream consumer-specific
 *   normalize can re-attempt with country context.
 */
export function prepareIdentity(
  input: RawIdentityInput,
  hashing: IdentityHashingOptions = {},
): PreparedIdentity {
  const hashEmail = hashing.email !== false;
  const hashPhone = hashing.phone !== false;

  const user_id = nonEmpty(input.user_id);
  const anonymous_id = nonEmpty(input.anonymous_id);

  let email: string | null = null;
  let email_sha256: string | null = null;
  const rawEmail = nonEmpty(input.email);
  if (rawEmail !== null) {
    email = rawEmail;
    if (hashEmail) {
      try {
        email_sha256 = hashEmailLower(rawEmail);
      } catch {
        // Whitespace-only input — canonical form is empty. Leave both
        // raw and hashed as null; the destination drops on
        // `no_usable_identity` if nothing else is present.
        email = null;
      }
    }
  }

  let phone: string | null = null;
  let phone_sha256: string | null = null;
  const rawPhone = nonEmpty(input.phone);
  if (rawPhone !== null) {
    phone = rawPhone.trim();
    if (hashPhone) {
      try {
        phone_sha256 = hashPhoneE164(rawPhone);
      } catch {
        // Non-E.164 — leave `phone` as the trimmed raw so a downstream
        // consumer-specific normalize stage can attempt a country-aware
        // reformat. `phone_sha256` remains `null`.
      }
    }
  }

  return {
    user_id,
    anonymous_id,
    email,
    email_sha256,
    phone,
    phone_sha256,
  };
}

/**
 * Pick the highest-priority usable identity from `PreparedIdentity`. Order:
 *
 *   1. user_id
 *   2. email_sha256
 *   3. phone_sha256
 *   4. anonymous_id
 *
 * Returns `undefined` when no identity field has a usable value. The
 * mapper layer typically uses the returned `kind` as the source label on
 * a per-destination identity metric.
 */
export function pickBestIdentity(identity: PreparedIdentity): BestIdentity | undefined {
  if (identity.user_id !== null) {
    return { kind: "user_id", value: identity.user_id };
  }
  if (identity.email_sha256 !== null) {
    return { kind: "email_sha256", value: identity.email_sha256 };
  }
  if (identity.phone_sha256 !== null) {
    return { kind: "phone_sha256", value: identity.phone_sha256 };
  }
  if (identity.anonymous_id !== null) {
    return { kind: "anonymous_id", value: identity.anonymous_id };
  }
  return undefined;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  if (value.trim().length === 0) return null;
  return value;
}
