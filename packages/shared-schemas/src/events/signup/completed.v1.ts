import { z } from "zod";

/**
 * `signup.completed` v1 — ACTIVE.
 *
 * Registration finished. Maps to Meta `CompleteRegistration`, GA4
 * `sign_up`, TikTok `CompleteRegistration`.
 *
 * `predicted_ltv_minor` is optional and, when present, is what the vendor
 * consumers pass as the registration's value — the one place a *predicted*
 * number legitimately rides a canonical event, because the prediction is
 * the producer's, not the platform's. A platform-computed LTV belongs in
 * profile traits instead.
 */
export const signupCompletedV1PropertiesSchema = z
  .object({
    /** How the account was created: password, google, apple, sso, invite, ... */
    registration_method: z.string().min(1).max(64),
    /** ISO 4217 code — required when `predicted_ltv_minor` is present. */
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, { message: "currency must be an ISO 4217 alphabetic code" })
      .nullish(),
    /** Producer-supplied predicted lifetime value, minor units. */
    predicted_ltv_minor: z.number().int().nonnegative().nullish(),
    /** Signup surface or campaign variant, when the producer tracks one. */
    signup_variant: z.string().min(1).max(64).nullish(),
  })
  .strict();

export type SignupCompletedV1Properties = z.infer<typeof signupCompletedV1PropertiesSchema>;
