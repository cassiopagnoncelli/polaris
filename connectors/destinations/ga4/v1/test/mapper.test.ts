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
 * @see connectors/destinations/ga4/v1/src/mapper.ts
 */

import { describe, expect, it } from "vitest";

import {
  CANONICAL_TO_GA4_EVENT,
  checkoutStartedMapper,
  GA4_EVENT_BEGIN_CHECKOUT,
  GA4_EVENT_LOGIN,
  GA4_EVENT_PURCHASE,
  GA4_EVENT_SIGN_UP,
  GA4_EVENT_SUBSCRIPTION_RENEWED,
  GA4_LOGIN_METHOD_POLARIS,
  paymentApprovedMapper,
  resolveAppInstanceId,
  resolveClientId,
  signupCompletedMapper,
  subscriptionRenewedMapper,
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

describe("signupCompletedMapper", () => {
  it("returns sign_up with method='polaris' and dedupe_key = event_id", () => {
    const ctx = fixtureMapperContext({ event: "signup.completed", properties: {} });
    const result = signupCompletedMapper(ctx);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.payload.name).toBe(GA4_EVENT_SIGN_UP);
    expect(result.payload.params?.method).toBe(GA4_LOGIN_METHOD_POLARIS);
    // GA4 does not dedupe sign_up — Polaris-side key falls through to event_id.
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });

  it("ignores envelope properties (sign_up is identity-only)", () => {
    const ctx = fixtureMapperContext({
      event: "signup.completed",
      properties: { currency: "USD", predicted_ltv_minor: 9999 },
    });
    const result = signupCompletedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params).toEqual({ method: GA4_LOGIN_METHOD_POLARIS });
  });
});

describe("subscriptionRenewedMapper", () => {
  it("returns subscription_renewed with currency + value + transaction_id", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: {
        currency: "USD",
        amount_minor: 1999,
        subscription_id: "sub_abc",
      },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.name).toBe(GA4_EVENT_SUBSCRIPTION_RENEWED);
    expect(result.payload.params).toEqual({
      currency: "USD",
      value: 19.99,
      transaction_id: "sub_abc",
    });
  });

  it("accepts `amount` as an alias for `amount_minor` (legacy producers)", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: { amount: 1999, currency: "USD" },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.value).toBe(19.99);
  });

  it("emits currency-only params when amount is missing", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: { currency: "USD" },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params).toEqual({ currency: "USD" });
    expect(result.payload.params?.value).toBeUndefined();
  });

  it("omits params entirely when no relevant slot is present", () => {
    const ctx = fixtureMapperContext({ event: "subscription.renewed", properties: {} });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params).toBeUndefined();
  });

  it("keeps dedupe_key on canonical event_id (GA4 does not dedupe custom events)", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: { subscription_id: "sub_xyz", amount_minor: 1999, currency: "USD" },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });
});

describe("resolveClientId — the GA4 web-stream client", () => {
  it("uses anonymous_id, which is what GA4 means by a client", () => {
    expect(resolveClientId(fixtureNormalizedEvent())).toBe(
      fixtureNormalizedEvent().identity.anonymous_id,
    );
  });

  it("falls back to profile_id for an event with no browser", () => {
    // A backend event has no anonymous_id. Coarser than a browser — one
    // person on two devices becomes one GA4 client — but stable, which is
    // the property that matters.
    const base = fixtureNormalizedEvent();
    const normalized = {
      ...base,
      identity: { ...base.identity, anonymous_id: null, profile_id: "prof_1" },
    };
    expect(resolveClientId(normalized)).toBe("prof_1");
  });

  it("never returns the delivery key, which changed on every event", () => {
    // The defect this replaces: `client_id` was the per-event delivery_key,
    // so GA4 saw one single-event user per delivery — no sessions, no
    // returning users. Any stable value beats it; an unstable one is the bug.
    const base = fixtureNormalizedEvent();
    const a = resolveClientId(base);
    const b = resolveClientId({ ...base, event_id: "a-different-event-id" });
    expect(a).toBe(b);
  });
});

describe("resolveAppInstanceId — app channel (KCS3ATPC)", () => {
  it("returns null when no app_* slot is populated", () => {
    expect(resolveAppInstanceId(fixtureNormalizedEvent())).toBeNull();
  });

  it("prefers app_idfv over app_gaid (iOS first)", () => {
    const normalized = fixtureNormalizedEvent();
    expect(
      resolveAppInstanceId({
        ...normalized,
        context: { ...normalized.context, app_idfv: "ios-uuid", app_gaid: "android-id" },
      }),
    ).toBe("ios-uuid");
  });

  it("falls back to app_gaid when only an Android device id is present", () => {
    const normalized = fixtureNormalizedEvent();
    expect(
      resolveAppInstanceId({
        ...normalized,
        context: { ...normalized.context, app_gaid: "android-id" },
      }),
    ).toBe("android-id");
  });

  it("returns null when app context is populated but no device id is set", () => {
    // app_bundle_id alone is not a stable per-device identifier; GA4 won't accept it as
    // `app_instance_id`. Operators relying on bundle-id-only events still flow through the
    // web-stream URL with the synthesized client_id.
    const normalized = fixtureNormalizedEvent();
    expect(
      resolveAppInstanceId({
        ...normalized,
        context: { ...normalized.context, app_bundle_id: "com.example.app" },
      }),
    ).toBeNull();
  });

  it("propagates app_instance_id onto the purchase payload via the mapper", () => {
    const normalized = fixtureNormalizedEvent({
      event: "payment.approved",
      properties: { amount_minor: 4999, currency: "USD", transaction_id: "tx_999" },
    });
    const ctx = {
      ...fixtureMapperContext(),
      normalized: {
        ...normalized,
        context: {
          ...normalized.context,
          app_bundle_id: "com.example.storefront",
          app_idfv: "11111111-2222-3333-4444-555555555555",
        },
      },
    };
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.app_instance_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("leaves app_instance_id undefined on the begin_checkout payload when no app context is present", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.app_instance_id).toBeUndefined();
  });
});

describe("CANONICAL_TO_GA4_EVENT", () => {
  it("pins the v1.x event matrix", () => {
    expect(CANONICAL_TO_GA4_EVENT["checkout.started"]).toBe(GA4_EVENT_BEGIN_CHECKOUT);
    expect(CANONICAL_TO_GA4_EVENT["payment.approved"]).toBe(GA4_EVENT_PURCHASE);
    expect(CANONICAL_TO_GA4_EVENT["user.identified"]).toBe(GA4_EVENT_LOGIN);
    expect(CANONICAL_TO_GA4_EVENT["signup.completed"]).toBe(GA4_EVENT_SIGN_UP);
    expect(CANONICAL_TO_GA4_EVENT["subscription.renewed"]).toBe(GA4_EVENT_SUBSCRIPTION_RENEWED);
  });
});
