import { z } from "zod";

/**
 * `payment.approved` v1 — ACTIVE.
 *
 * Emitted by a backend source (convention:
 * `catalog/sources/storefront/payments-api.yaml`) when a payment
 * authorisation succeeds. This is the revenue event every vendor consumer
 * maps to its purchase primitive — Meta `Purchase`, GA4 `purchase`,
 * TikTok `Purchase`, Braze `purchases`.
 *
 * Money is in MINOR units (`amount_minor`) because that is the only
 * representation that survives currency exponents without float error; the
 * destination normalizers convert to major units per vendor. Property style
 * here follows the payments-API convention already encoded in the vendor
 * golden fixtures — this schema was written to accept exactly what those
 * mappers already read, so registering it turns dead mapper code live
 * without touching a mapper.
 */
export const paymentApprovedV1PropertiesSchema = z
  .object({
    /** Merchant order identifier. Meta/TikTok use it as the vendor order id. */
    order_id: z.string().min(1).max(128),
    /** Authorised amount in minor currency units (e.g. cents). */
    amount_minor: z.number().int().nonnegative(),
    /** ISO 4217 three-letter currency code. */
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, { message: "currency must be an ISO 4217 alphabetic code" }),
    /** Processor-side transaction reference, when the gateway returns one. */
    transaction_id: z.string().min(1).max(128).nullish(),
    /** Cart this payment settles, when the flow started from a cart. */
    cart_id: z.string().min(1).max(128).nullish(),
    /** Payment instrument family (card, pix, boleto, ...) — never the instrument itself. */
    payment_method: z.string().min(1).max(64).nullish(),
  })
  .strict();

export type PaymentApprovedV1Properties = z.infer<typeof paymentApprovedV1PropertiesSchema>;
