/**
 * Behavioral tests for the tiktok v1 mappers.
 *
 * Each mapper is pure — no I/O, no clock, no PII reach. Pinned:
 *
 *   - per-event vendor name + dedupe_key=event_id
 *   - event_time conversion (ms → s with floor)
 *   - event_source inference (web vs crm)
 *   - user shape: email / phone hashed; external_id =
 *     sha256(canonical_customer_id ?? user_id); ip + ua passthrough;
 *     locale passthrough
 *   - properties: currency/value (minor → major), num_items sum,
 *     order_id from cart_id (checkout) or order_id/transaction_id (payment);
 *     contents[] per item with content_id + quantity + price
 *   - limited_data_use=1 on marketing-denied consent
 *
 * @see connectors/destinations/tiktok/v1/src/mapper.ts
 */

import { sha256Hex } from "@polaris/delivery-normalize";
import { describe, expect, it } from "vitest";

import {
  buildUserData,
  CANONICAL_TO_TIKTOK_EVENT,
  checkoutStartedMapper,
  inferEventSource,
  pageViewedMapper,
  paymentApprovedMapper,
  signupCompletedMapper,
  subscriptionRenewedMapper,
  TIKTOK_EVENT_COMPLETE_REGISTRATION,
  TIKTOK_EVENT_INITIATE_CHECKOUT,
  TIKTOK_EVENT_PAGEVIEW,
  TIKTOK_EVENT_PURCHASE,
  TIKTOK_EVENT_SUBSCRIBE,
  userIdentifiedMapper,
} from "../src/mapper.js";
import { fixtureMapperContext, fixtureNormalizedEvent } from "./fixtures/normalized.js";

describe("pageViewedMapper", () => {
  it("returns Pageview with dedupe_key = event_id", () => {
    const ctx = fixtureMapperContext({ event: "page.viewed" });
    const result = pageViewedMapper(ctx);

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.payload.event).toBe(TIKTOK_EVENT_PAGEVIEW);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.event_id).toBe(ctx.normalized.event_id);
  });

  it("spells the vendor event `Pageview`, not Meta's `PageView`", () => {
    // The two vendors disagree on the capital and TikTok rejects the name
    // it does not know, so the literal is pinned rather than inferred.
    expect(TIKTOK_EVENT_PAGEVIEW).toBe("Pageview");
  });

  it("carries the page url and referrer", () => {
    const result = pageViewedMapper(fixtureMapperContext({ event: "page.viewed" }));
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.page).toEqual({
      url: "https://storefront.example/checkout",
      referrer: "https://storefront.example/cart",
    });
  });

  it("emits no properties block", () => {
    // A view has no currency, value or contents, and the canonical
    // `path` / `title` / `name` / `category` have no TikTok counterpart
    // this version reads. An empty `properties` object would claim
    // otherwise on the wire.
    const result = pageViewedMapper(fixtureMapperContext({ event: "page.viewed" }));
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties).toBeUndefined();
  });

  it("carries the same hashed user block as every other event", () => {
    const ctx = fixtureMapperContext({ event: "page.viewed" });
    const result = pageViewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.user).toEqual(buildUserData(ctx.normalized));
  });

  it("keeps the consent gate: limited_data_use=1 on denied marketing", () => {
    // The card changes what TikTok is told about, not who is allowed to
    // tell it. A view is gated exactly as a checkout is.
    const result = pageViewedMapper(
      fixtureMapperContext({
        event: "page.viewed",
        consent: {
          status: "granted",
          dimensions: [{ dimension: "marketing", required: true, granted: false }],
        },
      }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.limited_data_use).toBe(1);
  });

  it("omits page entirely on a view with neither url nor referrer", () => {
    const normalized = fixtureNormalizedEvent({ event: "page.viewed" });
    const result = pageViewedMapper({
      ...fixtureMapperContext(),
      normalized: {
        ...normalized,
        context: { ...normalized.context, page_url: null, page_referrer: null },
      },
    });
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.page).toBeUndefined();
  });
});

describe("checkoutStartedMapper", () => {
  it("returns InitiateCheckout with dedupe_key = event_id", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.payload.event).toBe(TIKTOK_EVENT_INITIATE_CHECKOUT);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.event_id).toBe(ctx.normalized.event_id);
  });

  it("converts occurred_at to epoch seconds (TikTok requires seconds)", () => {
    const ctx = fixtureMapperContext({
      occurred_at_epoch_ms: Date.parse("2026-05-14T12:00:00.500Z"),
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    // 500ms should floor away.
    expect(result.payload.event_time).toBe(
      Math.floor(Date.parse("2026-05-14T12:00:00.500Z") / 1000),
    );
  });

  it("populates page.url when page_url is available", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.page?.url).toBe("https://storefront.example/checkout");
    expect(result.payload.page?.referrer).toBe("https://storefront.example/cart");
  });

  it("omits page entirely when neither url nor referrer is present", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: {
        ...normalized,
        context: { ...normalized.context, page_url: null, page_referrer: null },
      },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.page).toBeUndefined();
  });

  it("builds properties with currency + value (minor → major) + order_id + num_items", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties?.currency).toBe("USD");
    expect(result.payload.properties?.value).toBe(199.95);
    expect(result.payload.properties?.num_items).toBe(3);
    expect(result.payload.properties?.order_id).toBe("cart_42");
  });

  it("builds contents[] per cart item with content_id + quantity + price", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties?.contents).toEqual([
      { content_id: "sku-1", content_name: "Widget", quantity: 2, price: 49.99 },
      { content_id: "sku-2", content_name: "Gadget", quantity: 1, price: 99.97 },
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
    expect(result.payload.properties?.value).toBeUndefined();
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
    expect(result.payload.properties?.currency).toBe("JPY");
    expect(result.payload.properties?.value).toBe(19995);
  });

  it("omits properties entirely when no relevant slot is present", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: { ...normalized, properties: {} },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties).toBeUndefined();
  });
});

describe("paymentApprovedMapper", () => {
  it("returns Purchase with the same dedupe contract", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount_minor: 4999, currency: "USD", order_id: "ord_1" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.event).toBe(TIKTOK_EVENT_PURCHASE);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.properties?.currency).toBe("USD");
    expect(result.payload.properties?.value).toBe(49.99);
    expect(result.payload.properties?.order_id).toBe("ord_1");
  });

  it("accepts `amount` as an alias for `amount_minor` (legacy producers)", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount: 4999, currency: "USD" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties?.value).toBe(49.99);
  });

  it("prefers `transaction_id` for order_id when both are absent", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { transaction_id: "tx_999" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties?.order_id).toBe("tx_999");
  });
});

describe("userIdentifiedMapper", () => {
  it("returns CompleteRegistration with no properties", () => {
    const ctx = fixtureMapperContext({ event: "user.identified", properties: {} });
    const result = userIdentifiedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.event).toBe(TIKTOK_EVENT_COMPLETE_REGISTRATION);
    expect(result.payload.properties).toBeUndefined();
  });
});

describe("signupCompletedMapper", () => {
  it("returns CompleteRegistration with dedupe_key = event_id", () => {
    const ctx = fixtureMapperContext({ event: "signup.completed", properties: {} });
    const result = signupCompletedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.event).toBe(TIKTOK_EVENT_COMPLETE_REGISTRATION);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.event_id).toBe(ctx.normalized.event_id);
  });

  it("forwards currency when supplied", () => {
    const ctx = fixtureMapperContext({
      event: "signup.completed",
      properties: { currency: "USD" },
    });
    const result = signupCompletedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties).toEqual({ currency: "USD" });
  });

  it("omits properties when no currency is supplied", () => {
    const ctx = fixtureMapperContext({ event: "signup.completed", properties: {} });
    const result = signupCompletedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties).toBeUndefined();
  });
});

describe("subscriptionRenewedMapper", () => {
  it("returns Subscribe with currency + value + order_id from subscription_id", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: {
        currency: "USD",
        amount_minor: 1999,
        subscription_id: "sub_42",
      },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.event).toBe(TIKTOK_EVENT_SUBSCRIBE);
    expect(result.payload.properties).toEqual({
      currency: "USD",
      value: 19.99,
      order_id: "sub_42",
    });
  });

  it("accepts `amount` as an alias for `amount_minor` (legacy producers)", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: { amount: 1999, currency: "USD" },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties?.value).toBe(19.99);
  });

  it("emits currency-only properties when amount is missing", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: { currency: "USD" },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.properties).toEqual({ currency: "USD" });
    expect(result.payload.properties?.value).toBeUndefined();
  });
});

describe("buildUserData", () => {
  it("emits email from email_sha256 when present", () => {
    const normalized = fixtureNormalizedEvent();
    const ud = buildUserData(normalized);
    expect(ud.email).toBe(normalized.identity.email_sha256);
  });

  it("emits phone from phone_sha256 when present", () => {
    const normalized = fixtureNormalizedEvent();
    const ud = buildUserData(normalized);
    expect(ud.phone).toBe(normalized.identity.phone_sha256);
  });

  it("hashes the producer's user_id for external_id when nothing resolved", () => {
    // The unresolved case, and the one that must not move: an envelope
    // off `analytics.events` has no profile block at all.
    const normalized = fixtureNormalizedEvent();
    expect(normalized.identity.canonical_customer_id).toBeNull();
    const ud = buildUserData(normalized);
    expect(ud.external_id).toBe(sha256Hex("cust_12345"));
  });

  it("prefers canonical_customer_id over user_id for external_id", () => {
    // The join key should be the identity stage's conclusion, not one
    // producer's spelling — two producers naming the same customer
    // differently used to reach TikTok as two people.
    const normalized = fixtureNormalizedEvent({
      identity: {
        ...fixtureNormalizedEvent().identity,
        canonical_customer_id: "cus_canonical",
        user_id: "cust_12345",
      },
    });
    const ud = buildUserData(normalized);
    expect(ud.external_id).toBe(sha256Hex("cus_canonical"));
    expect(ud.external_id).not.toBe(sha256Hex("cust_12345"));
  });

  it("lowercases and trims whichever id it takes", () => {
    // Same canonicalization on both branches, which is what keeps the
    // digest comparable to the ids TikTok already holds.
    const base = fixtureNormalizedEvent().identity;
    const canonical = buildUserData(
      fixtureNormalizedEvent({
        identity: { ...base, canonical_customer_id: "  CUS_Canonical  " },
      }),
    );
    const producer = buildUserData(
      fixtureNormalizedEvent({
        identity: { ...base, canonical_customer_id: null, user_id: "  CUST_12345 " },
      }),
    );
    expect(canonical.external_id).toBe(sha256Hex("cus_canonical"));
    expect(producer.external_id).toBe(sha256Hex("cust_12345"));
  });

  it("passes IP + user-agent + locale through unchanged", () => {
    const normalized = fixtureNormalizedEvent();
    const ud = buildUserData(normalized);
    expect(ud.ip).toBe("203.0.113.42");
    expect(ud.user_agent).toBe("Mozilla/5.0");
    expect(ud.locale).toBe("en-US");
  });

  it("omits hashed fields whose source is null", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: null,
        email: null,
        email_sha256: null,
        phone: null,
        phone_sha256: null,
      },
    });
    const ud = buildUserData(normalized);
    expect(ud.email).toBeUndefined();
    expect(ud.phone).toBeUndefined();
    expect(ud.external_id).toBeUndefined();
  });
});

describe("inferEventSource", () => {
  it("returns 'web' when page_url is populated", () => {
    expect(inferEventSource(fixtureNormalizedEvent())).toBe("web");
  });

  it("returns 'crm' otherwise", () => {
    const n = fixtureNormalizedEvent();
    expect(inferEventSource({ ...n, context: { ...n.context, page_url: null } })).toBe("crm");
  });
});

describe("inferEventSource — app channel (WH7LZ0WZ)", () => {
  it("returns 'app' when any app_* slot is populated, even if page_url is also set", () => {
    const normalized = fixtureNormalizedEvent();
    const withApp = {
      ...normalized,
      context: {
        ...normalized.context,
        app_bundle_id: "com.example.shop",
        app_version: "5.10.2",
      },
    };
    expect(inferEventSource(withApp)).toBe("app");
  });

  it("falls back to 'web' / 'crm' when no app_* slots are present", () => {
    const n = fixtureNormalizedEvent();
    expect(inferEventSource(n)).toBe("web");
    const noApp = { ...n, context: { ...n.context, page_url: null } };
    expect(inferEventSource(noApp)).toBe("crm");
  });
});

describe("CANONICAL_TO_TIKTOK_EVENT", () => {
  it("pins the v1.x event matrix", () => {
    expect(CANONICAL_TO_TIKTOK_EVENT["page.viewed"]).toBe(TIKTOK_EVENT_PAGEVIEW);
    expect(CANONICAL_TO_TIKTOK_EVENT["checkout.started"]).toBe(TIKTOK_EVENT_INITIATE_CHECKOUT);
    expect(CANONICAL_TO_TIKTOK_EVENT["payment.approved"]).toBe(TIKTOK_EVENT_PURCHASE);
    expect(CANONICAL_TO_TIKTOK_EVENT["user.identified"]).toBe(TIKTOK_EVENT_COMPLETE_REGISTRATION);
    expect(CANONICAL_TO_TIKTOK_EVENT["signup.completed"]).toBe(TIKTOK_EVENT_COMPLETE_REGISTRATION);
    expect(CANONICAL_TO_TIKTOK_EVENT["subscription.renewed"]).toBe(TIKTOK_EVENT_SUBSCRIBE);
  });
});

describe("marketing-denied limited_data_use stamping", () => {
  it("stamps limited_data_use=1 when marketing consent is denied", () => {
    const ctx = fixtureMapperContext({
      consent: {
        status: "granted",
        dimensions: [{ dimension: "marketing", required: true, granted: false }],
      },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.limited_data_use).toBe(1);
  });

  it("omits limited_data_use when marketing consent is granted", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.limited_data_use).toBeUndefined();
  });
});
