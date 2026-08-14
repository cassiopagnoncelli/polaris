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
 * "Best-available identity" leads with what the platform RESOLVED and falls
 * back to what the producer OBSERVED:
 *
 *   canonical_customer_id > profile_id > user_id > email_sha256
 *     > phone_sha256 > anonymous_id
 *
 * The tail mirrors the partition-key picker rule from
 * `@polaris/shared-transport/buildRawEventsPartitionKey`; the two platform
 * identifiers at the head come from the envelope's profile block and are
 * absent until the identity stage has run.
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
  /**
   * The platform's resolved customer id for this person, from
   * `envelope.profile.canonical_customer_id`.
   *
   * Different in kind from `user_id` below, and that difference is the
   * reason it outranks it: `user_id` is what THIS event's producer said,
   * while this is what the identity stage concluded after reconciling every
   * identifier ever seen for the person. Two producers spelling the same
   * customer differently converge here and nowhere else.
   */
  readonly canonical_customer_id?: string | null | undefined;
  /**
   * The platform's own identifier for the person, from
   * `envelope.profile.profile_id`.
   *
   * Present on every resolved envelope even when the person has no customer
   * id at all, which is what makes it the reliable fallback: an anonymous
   * visitor on three devices is one `profile_id` and three `anonymous_id`s.
   */
  readonly profile_id?: string | null | undefined;
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
  /** Platform-resolved customer id. `null` on an unresolved envelope. */
  readonly canonical_customer_id: string | null;
  /** Platform-issued person id. `null` on an unresolved envelope. */
  readonly profile_id: string | null;
  readonly user_id: string | null;
  readonly anonymous_id: string | null;
  readonly email: string | null;
  readonly email_sha256: string | null;
  readonly phone: string | null;
  readonly phone_sha256: string | null;
}

/** Identifier the `pickBestIdentity` helper actually chose. */
export type BestIdentityKind =
  | "canonical_customer_id"
  | "profile_id"
  | "user_id"
  | "email_sha256"
  | "phone_sha256"
  | "anonymous_id";

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
    canonical_customer_id: nonEmpty(input.canonical_customer_id),
    profile_id: nonEmpty(input.profile_id),
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
 *   1. canonical_customer_id   platform-resolved, cross-producer
 *   2. profile_id              platform-issued, present whenever resolved
 *   3. user_id                 what this event's producer said
 *   4. email_sha256
 *   5. phone_sha256
 *   6. anonymous_id
 *
 * The two platform identifiers lead because they are conclusions drawn from
 * every identifier ever seen for the person, where the rest are single
 * observations from one event. Between them, `canonical_customer_id` wins
 * when present because a vendor can match on it; `profile_id` means nothing
 * outside Polaris but is stable and always there once resolved.
 *
 * `user_id` is RETAINED below them rather than replaced by
 * `canonical_customer_id`, which the redesign plan's ordering could be read
 * as implying. An envelope that has not been through the identity stage —
 * every vendor not yet flipped, and every replay of historical traffic —
 * carries no profile block at all, and dropping `user_id` from the chain
 * would silently demote those events to `email_sha256`. That is a live
 * behaviour change for destinations keying on a customer id today, in
 * exchange for nothing: on a resolved envelope a producer-supplied
 * `customer_id` is what the resolver wrote `canonical_customer_id` from, so
 * the higher rung is already occupied and this one is never reached.
 *
 * Returns `undefined` when no identity field has a usable value. The
 * mapper layer typically uses the returned `kind` as the source label on
 * a per-destination identity metric.
 */
export function pickBestIdentity(identity: PreparedIdentity): BestIdentity | undefined {
  if (identity.canonical_customer_id !== null) {
    return { kind: "canonical_customer_id", value: identity.canonical_customer_id };
  }
  if (identity.profile_id !== null) {
    return { kind: "profile_id", value: identity.profile_id };
  }
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
