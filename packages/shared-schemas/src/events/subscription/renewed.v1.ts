import { z } from "zod";

/**
 * `subscription.renewed` v1 — ACTIVE.
 *
 * A recurring billing cycle settled. Maps to Meta `Subscribe`, TikTok
 * `Subscribe`, and GA4's custom `subscription_renewed`.
 *
 * Distinct from `payment.approved` on purpose even though both settle
 * money: a renewal carries subscription lineage (`subscription_id`,
 * `billing_period`) that purchase mappers have no slot for, and collapsing
 * them would make recurring revenue indistinguishable from one-off revenue
 * downstream.
 */
export const subscriptionRenewedV1PropertiesSchema = z
  .object({
    /** Stable identifier of the subscription across all its renewals. */
    subscription_id: z.string().min(1).max(128),
    /** Amount billed for this cycle, minor currency units. */
    amount_minor: z.number().int().nonnegative(),
    /** ISO 4217 three-letter currency code. */
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, { message: "currency must be an ISO 4217 alphabetic code" }),
    /** Producer-supplied predicted lifetime value, minor units. */
    predicted_ltv_minor: z.number().int().nonnegative().nullish(),
    /** Plan or tier the subscription renewed onto. */
    plan_id: z.string().min(1).max(128).nullish(),
    /** Billing cadence: monthly, annual, ... */
    billing_period: z.string().min(1).max(32).nullish(),
    /** 1-based count of settled cycles, when the producer tracks it. */
    renewal_count: z.number().int().positive().nullish(),
  })
  .strict();

export type SubscriptionRenewedV1Properties = z.infer<typeof subscriptionRenewedV1PropertiesSchema>;
