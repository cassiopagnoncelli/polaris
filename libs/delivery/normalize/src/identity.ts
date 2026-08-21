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
 * Email and phone are the tuple every vendor takes; they are not the
 * whole set any vendor MATCHES on. Meta's `user_data` also takes first
 * name, last name, gender, birthday, city, state, postal code and
 * country, and TikTok, Reddit and Snap take the same eight under their
 * own spellings. Those are prepared here too, on the canonical forms in
 * `person.ts` and `address.ts`, for the same reason the first two are: a
 * vendor mapper that canonicalized its own would drift from the next
 * one's, and the digests would stop naming the same person.
 *
 * "Best-available identity" leads with what the platform RESOLVED and falls
 * back to what the producer OBSERVED:
 *
 *   canonical_customer_id > profile_id > user_id > email_sha256
 *     > phone_sha256 > anonymous_id
 *
 * The tail mirrors the partition-key picker rule from
 * `@polaris/bus/buildRawEventsPartitionKey`; the two platform
 * identifiers at the head come from the envelope's profile block and are
 * absent until the identity stage has run.
 *
 * Vendor mappers that need a single identity value (Meta's `external_id`
 * deduplication key, TikTok's `external_id`, Reddit's `external_id`) call
 * `pickBestIdentity` to get a stable choice.
 */

import { ADDRESS_MATCH_KEYS, normalizeAddress, type RawAddressMatchKeys } from "./address.js";
import { hashEmailLower } from "./email.js";
import { sha256Hex } from "./hashing.js";
import { normalizePerson, PERSON_MATCH_KEYS, type RawPersonMatchKeys } from "./person.js";
import { hashPhoneE164 } from "./phone.js";

/**
 * Raw identity inputs from the canonical envelope plus the producer-supplied
 * email / phone in `properties` (or `traits`). The destination consumer
 * pulls these out and hands them to `prepareIdentity`.
 *
 * Every field is optional. Empty strings, `null`, and `undefined` are
 * treated as missing.
 */
export interface RawIdentityInput extends RawPersonMatchKeys, RawAddressMatchKeys {
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

/**
 * The eight match keys beyond email and phone, raw as the producer or the
 * profile-trait snapshot spelled them. Canonicalized by `person.ts` and
 * `address.ts`; see those modules for the rule each one obeys.
 *
 * Split out as its own interface rather than folded into
 * `RawIdentityInput` because the trait reader and the properties hook
 * both produce exactly this and nothing else — the four identifiers above
 * come from the envelope, not from a bag of values.
 */
export interface RawMatchKeyInput extends RawPersonMatchKeys, RawAddressMatchKeys {
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
}

/**
 * Per-destination toggles for which PII the normalizer should hash.
 *
 * Two toggles, for the whole match set. The eight keys beyond email and
 * phone follow `email`, and that is a statement about what the flag has
 * always meant rather than a shortcut: a destination sets it to say
 * whether it takes hashed PII at all — Meta and TikTok require hashes,
 * Braze requires plaintext, and no vendor wants a hashed email beside a
 * plaintext first name. Binding the extended set to `email` is what makes
 * that impossible to configure by accident.
 *
 * A vendor that one day needs a split stance gets a toggle of its own
 * here, added deliberately with the mapper that needs it.
 */
export interface IdentityHashingOptions {
  /**
   * Hash email — and, with it, the eight extended match keys — if
   * present. Default: `true`.
   */
  readonly email?: boolean;
  /** Hash phone if present. Default: `true`. */
  readonly phone?: boolean;
}

/**
 * Prepared identity surface handed to the vendor mapper.
 *
 * Every match key has two slots — the plaintext canonical value and its
 * SHA-256 — and exactly ONE of them is ever populated. Which one is the
 * destination's own declaration: `IdentityHashingOptions` says whether
 * this vendor takes hashed PII, and the answer decides the slot.
 *
 * The mutual exclusion is the rule that matters, and it is what stops a
 * destination receiving a hashed email in its identity block and the
 * plaintext of the same address one field over. That claim is made about
 * the trait bag in `normalize.ts` and would be false here without this:
 * `webhook-sink` hands the whole prepared identity to its receiver, so a
 * populated raw slot IS a delivery of plaintext PII.
 *
 * A `null` on BOTH slots means the value was absent or the field's rule
 * refused it; mapper code can rely on the field name to know which
 * producer-supplied data it did not get.
 *
 * The one exception is `phone`, and it is the documented recovery path
 * rather than a leak: a non-E.164 phone produces no digest at all, so the
 * trimmed raw is kept instead — that is what lets a consumer-specific
 * normalize stage attempt a country-aware reformat and re-hash. `email`
 * has the same branch and it is unreachable, since a value that survives
 * the empty check always canonicalizes to something.
 *
 * The eight extended fields are OPTIONAL on this type and always PRESENT
 * on anything `prepareIdentity` returns. The optionality is for the
 * hand-written `NormalizedEvent` literals every connector's tests build:
 * a fixture pinning mapper behaviour for `em` should not have to
 * enumerate a match set its mapper does not read. Production code never
 * sees `undefined` here — but `exactOptionalPropertyTypes` makes a mapper
 * say so, which is the check that stops `[undefined]` reaching a vendor.
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

  /** Canonical first name (`person.ts`); `null` when hashing is on. */
  readonly first_name?: string | null;
  readonly first_name_sha256?: string | null;
  /** Canonical last name (`person.ts`); `null` when hashing is on. */
  readonly last_name?: string | null;
  readonly last_name_sha256?: string | null;
  /** `m` / `f` (`person.ts`); `null` when hashing is on. */
  readonly gender?: string | null;
  readonly gender_sha256?: string | null;
  /** `YYYYMMDD` (`person.ts`); `null` when hashing is on. */
  readonly birthday?: string | null;
  readonly birthday_sha256?: string | null;
  /** Canonical city (`address.ts`); `null` when hashing is on. */
  readonly city?: string | null;
  readonly city_sha256?: string | null;
  /** Canonical state (`address.ts`); `null` when hashing is on. */
  readonly state?: string | null;
  readonly state_sha256?: string | null;
  /** Canonical postal code (`address.ts`); `null` when hashing is on. */
  readonly postal_code?: string | null;
  readonly postal_code_sha256?: string | null;
  /** ISO-3166-1 alpha-2 (`address.ts`); `null` when hashing is on. */
  readonly country?: string | null;
  readonly country_sha256?: string | null;
}

/** The eight extended match keys, person half then address half. */
const MATCH_KEY_FIELDS = [...PERSON_MATCH_KEYS, ...ADDRESS_MATCH_KEYS] as const;
type MatchKeyField = (typeof MATCH_KEY_FIELDS)[number];

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
 *   phones leave `phone_sha256` null and `phone` carrying the trimmed raw
 *   input — a downstream consumer-specific normalize can re-attempt with
 *   country context.
 * - the eight extended match keys are canonicalized by their own rule
 *   (`person.ts`, `address.ts`) and then hashed. A value the rule
 *   refuses leaves both of its slots `null`, which is the same thing the
 *   caller does with an absent one.
 * - a destination that turns hashing off gets the canonical value on the
 *   plaintext slot instead. Never both: see `PreparedIdentity`.
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
    if (hashEmail) {
      try {
        email_sha256 = hashEmailLower(rawEmail);
      } catch {
        // Whitespace-only input — canonical form is empty. Both slots
        // stay null; the destination drops on `no_usable_identity` if
        // nothing else is present.
      }
    } else {
      email = rawEmail;
    }
  }

  let phone: string | null = null;
  let phone_sha256: string | null = null;
  const rawPhone = nonEmpty(input.phone);
  if (rawPhone !== null) {
    if (hashPhone) {
      try {
        phone_sha256 = hashPhoneE164(rawPhone);
      } catch {
        // Non-E.164, so there is no digest to send. `phone` carries the
        // trimmed raw instead, which is what lets a consumer-specific
        // normalize stage attempt a country-aware reformat and re-hash.
        phone = rawPhone.trim();
      }
    } else {
      phone = rawPhone.trim();
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
    ...prepareMatchKeys(input, hashEmail),
  };
}

/**
 * Canonicalize and hash the eight extended match keys.
 *
 * `hashed` decides which of the two slots each key gets — the digest when
 * the destination takes hashed PII, the canonical value when it takes
 * plaintext, never both, exactly as for the email/phone pair above.
 *
 * `sha256Hex` is called directly rather than through a per-field helper:
 * the canonicalization each field needs already happened in `person.ts` /
 * `address.ts`, and those rules never return an empty string, so the
 * empty-input guard the email and phone helpers wrap cannot fire here.
 */
function prepareMatchKeys(input: RawIdentityInput, hashed: boolean): Record<string, string | null> {
  const canonical: Record<MatchKeyField, string | null> = {
    ...normalizePerson(input),
    ...normalizeAddress(input),
  };
  const out: Record<string, string | null> = {};
  for (const field of MATCH_KEY_FIELDS) {
    const value = canonical[field];
    out[field] = hashed ? null : value;
    out[`${field}_sha256`] = hashed && value !== null ? sha256Hex(value) : null;
  }
  return out;
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
