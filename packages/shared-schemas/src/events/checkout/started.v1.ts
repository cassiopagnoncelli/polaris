import { z } from "zod";

/**
 * `checkout.started` v1 — ACTIVE.
 *
 * Captures the moment a customer begins a checkout flow. Property style
 * (currency in minor units, prefixed string IDs) is owner-defined per
 * `01-event-contract.md` § Property-level style is owner-defined.
 */
const cartItemSchema = z
  .object({
    sku: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    quantity: z.number().int().positive(),
    /** Per-unit price in minor currency units (e.g. cents). */
    unit_price: z.number().int().nonnegative(),
  })
  .strict();

export const checkoutStartedV1PropertiesSchema = z
  .object({
    cart_id: z.string().min(1).max(128),
    /** Cart total in minor currency units. */
    total: z.number().int().nonnegative(),
    /** ISO 4217 three-letter currency code. */
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, { message: "currency must be an ISO 4217 alphabetic code" }),
    items: z.array(cartItemSchema).min(1).max(500),
    /** Optional coupon/promo code attached to the cart. */
    coupon_code: z.string().min(1).max(64).nullish(),
    /** Checkout flow variant (A/B test bucket, redesign cohort, etc.). */
    flow_variant: z.string().min(1).max(64).nullish(),
  })
  .strict();

export type CheckoutStartedV1Properties = z.infer<typeof checkoutStartedV1PropertiesSchema>;
