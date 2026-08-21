import { z } from "zod";

/**
 * `user.identified` v1 — ACTIVE.
 *
 * The traits-carrying event. `identify(customerId, traits)` in both SDKs
 * emits it, and the identity stage merge-patches its properties into
 * `profiles.traits` — making it one of only three writers of profile traits
 * (the others being computed traits and reverse ETL).
 *
 * PASSTHROUGH, deliberately, and the only event in the catalog that is.
 * Traits are owner-defined by nature: a project's `plan`, `ltv_band` or
 * `nps_bucket` cannot be enumerated by the platform, and a `.strict()`
 * schema would reject every project that declared one. What the platform
 * DOES validate is the slots it consumes at the destination boundary: the
 * ad platforms and Braze match on these, so the normalizer has to hash and
 * reshape them, and it cannot do either to a key it has not named.
 *
 * Naming a slot is not closing the set. The schema stays `.passthrough()`,
 * and so do the two nested objects — a project that puts a `complement` in
 * its address keeps it, exactly as it keeps an `ltv_band` at the top level.
 * The justification for pinning is ADR-0001 #57 (property style is
 * owner-defined): the platform names what it *consumes*, and leaves the
 * rest to the owner.
 *
 * Consequence worth stating: unknown keys ride through to
 * `profiles.traits` unvalidated. That is the intended contract — traits are
 * project semantics, not platform semantics — and it is why the trait
 * snapshot carries a size guard rather than a field whitelist.
 *
 * Slots added in place on 2026-08-21 (no version bump): `name`, `gender`,
 * `birthday`, `avatar`, `title`, `username`, `website`, `created_at`,
 * `address`, `company`. See the catalog YAML for the Segment-name
 * correspondence and for what pinning costs a producer that was sending a
 * malformed value under one of these names.
 */

/**
 * Postal address. `.passthrough()` for the reason the parent is, and the
 * fields are pinned because destination audience matching hashes them.
 */
const addressSchema = z
  .object({
    street: z.string().min(1).max(256).nullish(),
    city: z.string().min(1).max(128).nullish(),
    /** State/province/region, as the producer names it. */
    state: z.string().min(1).max(128).nullish(),
    postal_code: z.string().min(1).max(32).nullish(),
    /**
     * ISO-3166-1 alpha-2 preferred, but kept a free string on purpose:
     * producers send "Brazil", "BR" and "bra" interchangeably, and the
     * normalizer is where that is reconciled. Rejecting at ingest would
     * lose the trait rather than fix it.
     */
    country: z.string().min(1).max(64).nullish(),
  })
  .passthrough();

/** B2B company block (Segment's `company` trait). */
const companySchema = z
  .object({
    id: z.string().min(1).max(128).nullish(),
    name: z.string().min(1).max(256).nullish(),
    industry: z.string().min(1).max(128).nullish(),
    employee_count: z.number().int().nonnegative().nullish(),
    plan: z.string().min(1).max(64).nullish(),
  })
  .passthrough();

export const userIdentifiedV1PropertiesSchema = z
  .object({
    /** Lowercased at normalization; hashed before it reaches any vendor. */
    email: z.string().email().max(320).nullish(),
    /** E.164 preferred; normalizers reject shapes they cannot canonicalise. */
    phone: z.string().min(1).max(32).nullish(),
    first_name: z.string().min(1).max(128).nullish(),
    last_name: z.string().min(1).max(128).nullish(),
    /** BCP 47 language tag, when the producer knows it. */
    locale: z.string().min(2).max(32).nullish(),
    /** Full name, for producers that never split it. */
    name: z.string().min(1).max(256).nullish(),
    /**
     * Free string, capped, deliberately not an enum. Meta wants `m`/`f`,
     * Google wants its own tokens, and producers send everything from
     * "male" to "non-binary" to a survey answer. Mapping that to a vendor
     * vocabulary is the normalizer's job; the catalog's job is to make the
     * value reachable under a known key.
     */
    gender: z.string().min(1).max(32).nullish(),
    /**
     * ISO calendar date, `YYYY-MM-DD`. Validated as a real date, not just
     * the shape — Meta's `db` is `YYYYMMDD`, so a "1990-02-30" that passes
     * ingest becomes a silently-dropped match key at the vendor.
     */
    birthday: z.string().date().nullish(),
    avatar: z.string().url().max(2048).nullish(),
    /** Job title. */
    title: z.string().min(1).max(128).nullish(),
    username: z.string().min(1).max(128).nullish(),
    website: z.string().url().max(2048).nullish(),
    /**
     * When the person's account was created, ISO 8601. Offsets are allowed
     * here, unlike the platform-stamped envelope timestamps: this value is
     * mirrored from whatever system owned the account before Polaris did,
     * and demanding UTC would reject a correct Segment `createdAt` for a
     * trait the platform only reads.
     */
    created_at: z.string().datetime({ offset: true }).nullish(),
    address: addressSchema.nullish(),
    company: companySchema.nullish(),
  })
  .passthrough();

export type UserIdentifiedV1Properties = z.infer<typeof userIdentifiedV1PropertiesSchema>;
