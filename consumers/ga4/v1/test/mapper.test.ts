/**
 * Behavioral tests for the ga4 v1 mappers.
 *
 * Each mapper is pure — no I/O, no clock, no PII reach. Pinned:
 *
 *   - per-event vendor name + dedupe_key semantics
 *   - properties: currency/value (minor → major), items[] per item with
 *     item_id + quantity + price
 *   - payment.approved → purchase carries transaction_id (preferred)
 *     or order_id (fallback); dedupe_key matches transaction_id
 *   - user.identified → login carries method='polaris'
 *
 * @see consumers/ga4/v1/src/mapper.ts
 */

import { describe, expect, it } from "vitest";

import {
  CANONICAL_TO_GA4_EVENT,
  checkoutStartedMapper,
  GA4_EVENT_BEGIN_CHECKOUT,
  GA4_EVENT_LOGIN,
  GA4_EVENT_PURCHASE,
  GA4_LOGIN_METHOD_POLARIS,
  paymentApprovedMapper,
  userIdentifiedMapper,
} from "../src/mapper.js";
import { fixtureMapperContext, fixtureNormalizedEvent } from "./fixtures/normalized.js";

describe("checkoutStartedMapper", () => {
  it("returns begin_checkout with dedupe_key = event_id", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.payload.name).toBe(GA4_EVENT_BEGIN_CHECKOUT);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });

  it("builds params with currency + value (minor → major)", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.currency).toBe("USD");
    expect(result.payload.params?.value).toBe(199.95);
  });

  it("builds items[] per cart item with item_id + quantity + price", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.items).toEqual([
      { item_id: "sku-1", item_name: "Widget", quantity: 2, price: 49.99 },
      { item_id: "sku-2", item_name: "Gadget", quantity: 1, price: 99.97 },
    ]);
  });

  it("omits value when currency is missing", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: {
        ...normalized,
        properties: { ...normalized.properties, currency: undefined },
      },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.value).toBeUndefined();
  });

  it("handles zero-decimal currencies (JPY) without dividing", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: {
        ...normalized,
        properties: { ...normalized.properties, currency: "JPY", total: 19995 },
      },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.currency).toBe("JPY");
    expect(result.payload.params?.value).toBe(19995);
  });

  it("omits params entirely when no relevant slot is present", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: { ...normalized, properties: {} },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params).toBeUndefined();
  });
});

describe("paymentApprovedMapper", () => {
  it("returns purchase with transaction_id-derived dedupe_key", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount_minor: 4999, currency: "USD", transaction_id: "tx_999" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.name).toBe(GA4_EVENT_PURCHASE);
    // CRITICAL: purchase dedupe keys on transaction_id, not event_id.
    expect(result.dedupe_key).toBe("tx_999");
    expect(result.payload.params?.currency).toBe("USD");
    expect(result.payload.params?.value).toBe(49.99);
    expect(result.payload.params?.transaction_id).toBe("tx_999");
  });

  it("accepts `amount` as an alias for `amount_minor` (legacy producers)", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount: 4999, currency: "USD" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.value).toBe(49.99);
  });

  it("prefers transaction_id over order_id for dedupe", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { transaction_id: "tx_999", order_id: "ord_888" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.transaction_id).toBe("tx_999");
    expect(result.dedupe_key).toBe("tx_999");
  });

  it("falls back to order_id when transaction_id is absent", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { order_id: "ord_888" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.transaction_id).toBe("ord_888");
    expect(result.dedupe_key).toBe("ord_888");
  });

  it("falls back to event_id for dedupe when neither transaction_id nor order_id is present", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount_minor: 4999, currency: "USD" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.transaction_id).toBeUndefined();
    // GA4 will not dedupe cross-channel in this case; the Polaris-side
    // dedupe_key still has to be stable so triage queries work.
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });
});

describe("userIdentifiedMapper", () => {
  it("returns login with method='polaris'", () => {
    const ctx = fixtureMapperContext({ event: "user.identified", properties: {} });
    const result = userIdentifiedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.name).toBe(GA4_EVENT_LOGIN);
    expect(result.payload.params?.method).toBe(GA4_LOGIN_METHOD_POLARIS);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });
});

describe("CANONICAL_TO_GA4_EVENT", () => {
  it("pins the v1 event matrix", () => {
    expect(CANONICAL_TO_GA4_EVENT["checkout.started"]).toBe(GA4_EVENT_BEGIN_CHECKOUT);
    expect(CANONICAL_TO_GA4_EVENT["payment.approved"]).toBe(GA4_EVENT_PURCHASE);
    expect(CANONICAL_TO_GA4_EVENT["user.identified"]).toBe(GA4_EVENT_LOGIN);
  });
});
