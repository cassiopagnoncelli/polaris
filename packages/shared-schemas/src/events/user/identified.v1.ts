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
 * DOES validate is the handful of slots it consumes: `email` and `phone`
 * feed destination identity hashing, so their shapes are pinned even though
 * their presence is not required.
 *
 * Consequence worth stating: unknown keys ride through to
 * `profiles.traits` unvalidated. That is the intended contract — traits are
 * project semantics, not platform semantics — and it is why the trait
 * snapshot carries a size guard rather than a field whitelist.
 */
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
  })
  .passthrough();

export type UserIdentifiedV1Properties = z.infer<typeof userIdentifiedV1PropertiesSchema>;
