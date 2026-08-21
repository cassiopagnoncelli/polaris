/**
 * Behavioral tests for the meta-capi v1 mappers.
 *
 * Each mapper is pure — no I/O, no clock, no PII reach. Pinned:
 *
 *   - per-event vendor name + dedupe_key=event_id
 *   - event_time conversion (ms → s with floor)
 *   - action_source inference (website vs system_generated)
 *   - user_data shape: em / ph and the eight further customer-information
 *     parameters hashed; external_id = sha256(user_id); anon_id =
 *     sha256(anonymous_id) on app events only; fbp/fbc passthrough when
 *     present; client_ip + ua passthrough
 *   - the geo fallback for ct / st / country: off unless the instance asks
 *     for it, and never ahead of a trait
 *   - custom_data: currency/value (minor → major), num_items sum,
 *     contents[] / content_ids / content_type from items[],
 *     order_id from cart_id (checkout) or order_id/transaction_id (payment)
 *   - data_processing_options=["LDU"] on marketing-denied consent
 *
 * @see connectors/destinations/meta-capi/v1/src/mapper.ts
 */

import { prepareIdentity, sha256Hex } from "@polaris/delivery-normalize";
import { describe, expect, it } from "vitest";

import {
  buildUserData,
  CANONICAL_TO_META_EVENT,
  checkoutStartedMapper,
  inferActionSource,
  META_EVENT_COMPLETE_REGISTRATION,
  META_EVENT_INITIATE_CHECKOUT,
  META_EVENT_LEAD,
  META_EVENT_PAGE_VIEW,
  META_EVENT_PURCHASE,
  META_EVENT_SUBSCRIBE,
  pageViewedMapper,
  paymentApprovedMapper,
  signupCompletedMapper,
  subscriptionRenewedMapper,
  userIdentifiedMapper,
} from "../src/mapper.js";
import {
  FIXTURE_MATCH_DIGESTS,
  fixtureExtendedIdentity,
  fixtureMapperContext,
  fixtureNormalizedEvent,
} from "./fixtures/normalized.js";

/**
 * The same event arriving from a native app rather than a browser. Meta's
 * `anon_id` is defined for app events only, so several assertions below
 * need one.
 */
function appEvent(overrides: Parameters<typeof fixtureNormalizedEvent>[0] = {}) {
  const base = fixtureNormalizedEvent(overrides);
  return {
    ...base,
    context: { ...base.context, page_url: null, app_bundle_id: "com.example.shop" },
  };
}

describe("checkoutStartedMapper", () => {
  it("returns InitiateCheckout with dedupe_key = event_id", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.payload.event_name).toBe(META_EVENT_INITIATE_CHECKOUT);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.event_id).toBe(ctx.normalized.event_id);
  });

  it("converts occurred_at to epoch seconds (Meta requires seconds)", () => {
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

  it("infers action_source='website' when page_url is populated", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.action_source).toBe("website");
    expect(result.payload.event_source_url).toBe("https://storefront.example/checkout");
  });

  it("infers action_source='system_generated' when page_url is null", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: { ...normalized, context: { ...normalized.context, page_url: null } },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.action_source).toBe("system_generated");
    expect(result.payload.event_source_url).toBeUndefined();
  });

  it("builds the whole custom_data block for a cart", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    // The exhaustive shape, so a field appearing here without a decision
    // fails this test rather than reaching Meta unnoticed.
    expect(result.payload.custom_data).toEqual({
      currency: "USD",
      value: 199.95,
      num_items: 3,
      contents: [
        { id: "sku-1", quantity: 2, item_price: 49.99 },
        { id: "sku-2", quantity: 1, item_price: 99.97 },
      ],
      content_ids: ["sku-1", "sku-2"],
      content_type: "product",
      order_id: "cart_42",
    });
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
    expect(result.payload.custom_data?.value).toBeUndefined();
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
    expect(result.payload.custom_data?.currency).toBe("JPY");
    expect(result.payload.custom_data?.value).toBe(19995);
  });

  it("omits custom_data entirely when no relevant property is present", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: { ...normalized, properties: {} },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data).toBeUndefined();
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
    expect(result.payload.event_name).toBe(META_EVENT_PURCHASE);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.custom_data).toEqual({
      currency: "USD",
      value: 49.99,
      order_id: "ord_1",
    });
  });

  it("accepts `amount` as an alias for `amount_minor` (legacy producers)", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount: 4999, currency: "USD" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.value).toBe(49.99);
  });

  it("prefers `transaction_id` for order_id when both are absent", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { transaction_id: "tx_999" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.order_id).toBe("tx_999");
  });
});

describe("signupCompletedMapper", () => {
  it("returns CompleteRegistration with dedupe_key = event_id", () => {
    const ctx = fixtureMapperContext({ event: "signup.completed", properties: {} });
    const result = signupCompletedMapper(ctx);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.payload.event_name).toBe(META_EVENT_COMPLETE_REGISTRATION);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.event_id).toBe(ctx.normalized.event_id);
  });

  it("omits custom_data when no predicted_ltv / currency is supplied", () => {
    const ctx = fixtureMapperContext({ event: "signup.completed", properties: {} });
    const result = signupCompletedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data).toBeUndefined();
  });

  it("populates currency + predicted_ltv (minor → major) when both are present", () => {
    const ctx = fixtureMapperContext({
      event: "signup.completed",
      properties: { currency: "USD", predicted_ltv_minor: 9999 },
    });
    const result = signupCompletedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data).toEqual({
      currency: "USD",
      predicted_ltv: 99.99,
    });
  });

  it("ignores predicted_ltv_minor when currency is absent", () => {
    const ctx = fixtureMapperContext({
      event: "signup.completed",
      properties: { predicted_ltv_minor: 9999 },
    });
    const result = signupCompletedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    // Per the spec: both currency + predicted_ltv must be present for the
    // ltv slot to populate.
    expect(result.payload.custom_data).toBeUndefined();
  });
});

describe("subscriptionRenewedMapper", () => {
  it("returns Subscribe with currency + value + order_id from subscription_id", () => {
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
    expect(result.payload.event_name).toBe(META_EVENT_SUBSCRIBE);
    expect(result.payload.custom_data).toEqual({
      currency: "USD",
      value: 19.99,
      order_id: "sub_abc",
    });
  });

  it("accepts `amount` as an alias for `amount_minor` (legacy producers)", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: { amount: 1999, currency: "USD" },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.value).toBe(19.99);
  });

  it("forwards predicted_ltv when supplied alongside currency", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: {
        currency: "USD",
        amount_minor: 1999,
        predicted_ltv_minor: 99999,
      },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.predicted_ltv).toBe(999.99);
  });

  it("emits currency-only custom_data when amount is missing", () => {
    const ctx = fixtureMapperContext({
      event: "subscription.renewed",
      properties: { currency: "USD" },
    });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data).toEqual({ currency: "USD" });
    expect(result.payload.custom_data?.value).toBeUndefined();
  });
});

describe("userIdentifiedMapper", () => {
  it("returns Lead with no custom_data", () => {
    const ctx = fixtureMapperContext({ event: "user.identified", properties: {} });
    const result = userIdentifiedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.event_name).toBe(META_EVENT_LEAD);
    expect(result.payload.custom_data).toBeUndefined();
  });
});

describe("buildUserData", () => {
  it("emits em from email_sha256 when present", () => {
    const normalized = fixtureNormalizedEvent();
    const ud = buildUserData(normalized);
    expect(ud.em).toEqual([normalized.identity.email_sha256]);
  });

  it("emits ph from phone_sha256 when present", () => {
    const normalized = fixtureNormalizedEvent();
    const ud = buildUserData(normalized);
    expect(ud.ph).toEqual([normalized.identity.phone_sha256]);
  });

  it("hashes the canonical user_id for external_id", () => {
    const normalized = fixtureNormalizedEvent();
    const ud = buildUserData(normalized);
    // Test stays robust to canonicalization rules — assert against the
    // documented contract: sha256(lowercased(trim(user_id))).
    const expected = sha256Hex((normalized.identity.user_id ?? "").toLowerCase().trim());
    expect(ud.external_id).toEqual([expected]);
  });

  it("hashes the canonical anonymous_id for anon_id on an app event", () => {
    const normalized = appEvent();
    const ud = buildUserData(normalized);
    const expected = sha256Hex(normalized.identity.anonymous_id ?? "");
    expect(ud.anon_id).toBe(expected);
  });

  it("passes IP + user-agent through unchanged", () => {
    const normalized = fixtureNormalizedEvent();
    const ud = buildUserData(normalized);
    expect(ud.client_ip_address).toBe("203.0.113.42");
    expect(ud.client_user_agent).toBe("Mozilla/5.0");
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
    expect(ud.em).toBeUndefined();
    expect(ud.ph).toBeUndefined();
    expect(ud.external_id).toBeUndefined();
    expect(ud.anon_id).toBeUndefined();
  });
});

describe("inferActionSource", () => {
  it("returns 'website' when page_url is populated", () => {
    expect(inferActionSource(fixtureNormalizedEvent())).toBe("website");
  });

  it("returns 'system_generated' otherwise", () => {
    const n = fixtureNormalizedEvent();
    expect(inferActionSource({ ...n, context: { ...n.context, page_url: null } })).toBe(
      "system_generated",
    );
  });
});

describe("inferActionSource — app channel (G7ZCYLL6)", () => {
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
    expect(inferActionSource(withApp)).toBe("app");
  });

  it("propagates 'app' through the checkout mapper's payload", () => {
    const baseCtx = fixtureMapperContext();
    const ctx = {
      ...baseCtx,
      normalized: {
        ...baseCtx.normalized,
        context: {
          ...baseCtx.normalized.context,
          app_bundle_id: "com.example.shop",
        },
      },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.action_source).toBe("app");
  });
});

describe("CANONICAL_TO_META_EVENT", () => {
  it("pins the v1.x event matrix", () => {
    expect(CANONICAL_TO_META_EVENT["checkout.started"]).toBe(META_EVENT_INITIATE_CHECKOUT);
    expect(CANONICAL_TO_META_EVENT["payment.approved"]).toBe(META_EVENT_PURCHASE);
    expect(CANONICAL_TO_META_EVENT["user.identified"]).toBe(META_EVENT_LEAD);
    expect(CANONICAL_TO_META_EVENT["signup.completed"]).toBe(META_EVENT_COMPLETE_REGISTRATION);
    expect(CANONICAL_TO_META_EVENT["subscription.renewed"]).toBe(META_EVENT_SUBSCRIBE);
  });
});

describe("marketing-denied LDU stamping", () => {
  it("stamps data_processing_options=['LDU'] when marketing consent is denied", () => {
    const ctx = fixtureMapperContext({
      consent: {
        status: "granted",
        dimensions: [{ dimension: "marketing", required: true, granted: false }],
      },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.data_processing_options).toEqual(["LDU"]);
  });

  it("omits data_processing_options when marketing consent is granted", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.data_processing_options).toBeUndefined();
  });
});

describe("external_id — the resolved customer id (MVKUP64R)", () => {
  it("prefers canonical_customer_id over the producer's user_id", () => {
    // Meta's cross-session join key should carry the most durable id we
    // have. Two producers spelling the same customer differently used to
    // land as two Meta users and now converge.
    const base = fixtureNormalizedEvent();
    const normalized = {
      ...base,
      identity: { ...base.identity, user_id: "producer_spelling", canonical_customer_id: "cus_1" },
    };
    const result = checkoutStartedMapper({ ...fixtureMapperContext(), normalized });
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.user_data.external_id).toEqual([sha256Hex("cus_1")]);
  });

  it("keeps prior behaviour when nothing was resolved", () => {
    // An analytics.events envelope, or a person the resolver has not linked
    // to a customer id. Nothing changes for traffic off the spine.
    const base = fixtureNormalizedEvent();
    const normalized = {
      ...base,
      identity: { ...base.identity, user_id: "producer_spelling", canonical_customer_id: null },
    };
    const result = checkoutStartedMapper({ ...fixtureMapperContext(), normalized });
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.user_data.external_id).toEqual([sha256Hex("producer_spelling")]);
  });
});

describe("custom_data.contents — the cart Meta joins to a catalogue", () => {
  it("emits contents[], content_ids and content_type on InitiateCheckout", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.contents).toEqual([
      { id: "sku-1", quantity: 2, item_price: 49.99 },
      { id: "sku-2", quantity: 1, item_price: 99.97 },
    ]);
    expect(result.payload.custom_data?.content_ids).toEqual(["sku-1", "sku-2"]);
    expect(result.payload.custom_data?.content_type).toBe("product");
  });

  it("leaves num_items exactly as it was", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.num_items).toBe(3);
  });

  it("emits contents[] on Purchase, and still no num_items", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: {
        order_id: "ord_1",
        amount_minor: 14996,
        currency: "USD",
        items: [{ sku: "sku-1", quantity: 3, unit_price: 4999 }],
      },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.contents).toEqual([
      { id: "sku-1", quantity: 3, item_price: 49.99 },
    ]);
    expect(result.payload.custom_data?.content_ids).toEqual(["sku-1"]);
    expect(result.payload.custom_data?.content_type).toBe("product");
    expect(result.payload.custom_data?.num_items).toBeUndefined();
  });

  it("omits all three when the event carries no items[]", () => {
    const ctx = fixtureMapperContext({
      properties: { cart_id: "cart_42", total: 19995, currency: "USD" },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.contents).toBeUndefined();
    expect(result.payload.custom_data?.content_ids).toBeUndefined();
    expect(result.payload.custom_data?.content_type).toBeUndefined();
  });

  it("omits all three when every line is unreadable", () => {
    const ctx = fixtureMapperContext({
      properties: { currency: "USD", items: [null, "sku-1", 7] },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.contents).toBeUndefined();
    expect(result.payload.custom_data?.content_type).toBeUndefined();
  });

  it("prefers an explicit content_id over the sku, as the TikTok builder does", () => {
    const ctx = fixtureMapperContext({
      properties: {
        currency: "USD",
        items: [{ sku: "sku-1", content_id: "catalogue-77", quantity: 1 }],
      },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.content_ids).toEqual(["catalogue-77"]);
  });

  it("keeps a line that has a quantity but no id, and leaves it out of content_ids", () => {
    const ctx = fixtureMapperContext({
      properties: { currency: "USD", items: [{ quantity: 2, unit_price: 500 }] },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.contents).toEqual([{ quantity: 2, item_price: 5 }]);
    expect(result.payload.custom_data?.content_ids).toBeUndefined();
    expect(result.payload.custom_data?.content_type).toBeUndefined();
  });

  it("drops item_price when the event carries no currency to convert with", () => {
    const ctx = fixtureMapperContext({
      properties: { items: [{ sku: "sku-1", quantity: 1, unit_price: 4999 }] },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.contents).toEqual([{ id: "sku-1", quantity: 1 }]);
  });

  it("refuses a non-integer or non-positive quantity", () => {
    const ctx = fixtureMapperContext({
      properties: {
        currency: "USD",
        items: [
          { sku: "sku-1", quantity: 1.5 },
          { sku: "sku-2", quantity: 0 },
          { sku: "sku-3", quantity: -2 },
        ],
      },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data?.contents).toEqual([
      { id: "sku-1" },
      { id: "sku-2" },
      { id: "sku-3" },
    ]);
  });
});

describe("user_data — the eight further customer-information parameters", () => {
  const cases = [
    ["fn", "first_name"],
    ["ln", "last_name"],
    ["ge", "gender"],
    ["db", "birthday"],
    ["ct", "city"],
    ["st", "state"],
    ["zp", "postal_code"],
    ["country", "country"],
  ] as const;

  for (const [wire, field] of cases) {
    it(`emits ${wire} from ${field}_sha256 when the identity carries it`, () => {
      const normalized = fixtureNormalizedEvent({ identity: fixtureExtendedIdentity() });
      const ud = buildUserData(normalized);
      expect(ud[wire]).toEqual([FIXTURE_MATCH_DIGESTS[field]]);
    });

    it(`omits ${wire} when ${field}_sha256 is null`, () => {
      const normalized = fixtureNormalizedEvent({
        identity: fixtureExtendedIdentity({ [`${field}_sha256`]: null }),
      });
      const ud = buildUserData(normalized);
      expect(ud[wire]).toBeUndefined();
    });
  }

  it("omits all eight for an identity that never had them (a bare fixture)", () => {
    const ud = buildUserData(fixtureNormalizedEvent());
    for (const [wire] of cases) expect(ud[wire]).toBeUndefined();
  });

  it("carries them through to the payload, not just the helper", () => {
    const ctx = fixtureMapperContext({ identity: fixtureExtendedIdentity() });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.user_data.fn).toEqual([FIXTURE_MATCH_DIGESTS.first_name]);
    expect(result.payload.user_data.country).toEqual([FIXTURE_MATCH_DIGESTS.country]);
  });
});

describe("location from geo — off by default, and never ahead of a trait", () => {
  const GEO = { country: "BR", region: "São Paulo", city: "São Paulo", source: "maxmind" };
  // The digests the trait path would produce for the same three values, so
  // the assertions below prove the fallback is comparable rather than merely
  // populated.
  const expected = prepareIdentity({ city: GEO.city, state: GEO.region, country: GEO.country });

  it("sends nothing from geo when the instance has not asked for it", () => {
    const ud = buildUserData(fixtureNormalizedEvent({ enrichment: { geo: GEO } }));
    expect(ud.ct).toBeUndefined();
    expect(ud.st).toBeUndefined();
    expect(ud.country).toBeUndefined();
  });

  it("fills ct / st / country when the instance switch is on", () => {
    const ud = buildUserData(fixtureNormalizedEvent({ enrichment: { geo: GEO } }), {
      locationFromGeo: true,
    });
    expect(ud.ct).toEqual([expected.city_sha256]);
    expect(ud.st).toEqual([expected.state_sha256]);
    expect(ud.country).toEqual([expected.country_sha256]);
  });

  it("never fills zp — geo has no postal code to fall back to", () => {
    const ud = buildUserData(fixtureNormalizedEvent({ enrichment: { geo: GEO } }), {
      locationFromGeo: true,
    });
    expect(ud.zp).toBeUndefined();
  });

  it("lets the person's own traits win over geo, field by field", () => {
    const identity = fixtureExtendedIdentity({ state_sha256: null });
    const ud = buildUserData(fixtureNormalizedEvent({ identity, enrichment: { geo: GEO } }), {
      locationFromGeo: true,
    });
    // Trait present -> trait. Trait absent -> geo. Both in one payload.
    expect(ud.ct).toEqual([FIXTURE_MATCH_DIGESTS.city]);
    expect(ud.country).toEqual([FIXTURE_MATCH_DIGESTS.country]);
    expect(ud.st).toEqual([expected.state_sha256]);
  });

  it("sends nothing when enrichment resolved no geo at all", () => {
    const ud = buildUserData(fixtureNormalizedEvent({ enrichment: { geo: null } }), {
      locationFromGeo: true,
    });
    expect(ud.ct).toBeUndefined();
  });

  it("skips a geo field the address rules refuse rather than hashing a guess", () => {
    const ud = buildUserData(
      fixtureNormalizedEvent({
        enrichment: { geo: { country: "Korea", region: null, city: "Seoul", source: "maxmind" } },
      }),
      { locationFromGeo: true },
    );
    // "Korea" is two countries; `canonicalizeCountry` refuses it.
    expect(ud.country).toBeUndefined();
    expect(ud.st).toBeUndefined();
    expect(ud.ct).toEqual([prepareIdentity({ city: "Seoul" }).city_sha256]);
  });

  it("reads the switch off the instance config, and only the boolean true", () => {
    const geo = { enrichment: { geo: GEO } };
    const on = checkoutStartedMapper(fixtureMapperContext(geo, { location_from_geo: true }));
    const stringy = checkoutStartedMapper(fixtureMapperContext(geo, { location_from_geo: "true" }));
    const off = checkoutStartedMapper(fixtureMapperContext(geo, {}));
    if (on.kind !== "mapped" || stringy.kind !== "mapped" || off.kind !== "mapped") {
      throw new Error("expected mapped");
    }
    expect(on.payload.user_data.ct).toEqual([expected.city_sha256]);
    expect(stringy.payload.user_data.ct).toBeUndefined();
    expect(off.payload.user_data.ct).toBeUndefined();
  });
});

describe("anon_id — app events only", () => {
  it("is omitted on a website event even though anonymous_id is present", () => {
    const normalized = fixtureNormalizedEvent();
    expect(normalized.identity.anonymous_id).not.toBeNull();
    expect(buildUserData(normalized).anon_id).toBeUndefined();
  });

  it("is omitted on a system_generated event", () => {
    const base = fixtureNormalizedEvent();
    const normalized = { ...base, context: { ...base.context, page_url: null } };
    expect(buildUserData(normalized).anon_id).toBeUndefined();
  });

  it("is sent on an app event", () => {
    const normalized = appEvent();
    expect(buildUserData(normalized).anon_id).toBe(sha256Hex("anon_abc"));
  });

  it("reaches the payload of an app-sourced purchase", () => {
    const ctx = {
      ...fixtureMapperContext(),
      normalized: appEvent({ event: "payment.approved", properties: { currency: "USD" } }),
    };
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.action_source).toBe("app");
    expect(result.payload.user_data.anon_id).toBe(sha256Hex("anon_abc"));
  });
});

describe("pageViewedMapper", () => {
  it("returns PageView with dedupe_key = event_id and the page URL", () => {
    const ctx = fixtureMapperContext({ event: "page.viewed", properties: {} });
    const result = pageViewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.event_name).toBe(META_EVENT_PAGE_VIEW);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.event_source_url).toBe("https://storefront.example/checkout");
    expect(result.payload.action_source).toBe("website");
  });

  it("never carries custom_data, even when the event has properties", () => {
    const ctx = fixtureMapperContext({
      event: "page.viewed",
      properties: { title: "Checkout", currency: "USD", total: 19995 },
    });
    const result = pageViewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data).toBeUndefined();
  });

  it("still carries the identity Meta matches on", () => {
    const ctx = fixtureMapperContext({
      event: "page.viewed",
      properties: {},
      identity: fixtureExtendedIdentity(),
    });
    const result = pageViewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.user_data.em).toEqual(["a".repeat(64)]);
    expect(result.payload.user_data.fn).toEqual([FIXTURE_MATCH_DIGESTS.first_name]);
  });

  it("is in the event matrix", () => {
    expect(CANONICAL_TO_META_EVENT["page.viewed"]).toBe(META_EVENT_PAGE_VIEW);
  });
});
