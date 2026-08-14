/**
 * Behavioral tests for the braze v1 mappers.
 *
 * Each mapper is pure — no I/O, no clock, no PII reach. Pinned:
 *
 *   - per-canonical-event family selection (events vs purchases vs attributes)
 *   - external_id resolution from user_id → anonymous_id fallback chain
 *   - external_id lowercased + trimmed
 *   - time is ISO 8601 passthrough (not Unix seconds)
 *   - currency / value minor → major conversion
 *   - skip outcomes when required slots (currency, amount, product_id,
 *     external_id) are missing
 *   - dedupe_key = canonical event_id (audit-only — Braze ignores it)
 *   - user.identified emits raw email/phone (NOT hashed) +
 *     _update_existing_only=false
 *
 * @see sync/destinations/braze/v1/src/mapper.ts
 */

import { describe, expect, it } from "vitest";

import {
  BRAZE_EVENT_CHECKOUT_STARTED,
  CANONICAL_TO_BRAZE_FAMILY,
  checkoutStartedMapper,
  paymentApprovedMapper,
  resolveDeviceId,
  resolveExternalId,
  resolveUserAlias,
  userIdentifiedMapper,
} from "../src/mapper.js";
import { fixtureMapperContext, fixtureNormalizedEvent } from "./fixtures/normalized.js";

describe("checkoutStartedMapper", () => {
  it("returns an events[] entry with name='checkout_started' + dedupe_key = event_id", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
    expect(result.payload.events).toHaveLength(1);
    expect(result.payload.purchases).toBeUndefined();
    expect(result.payload.attributes).toBeUndefined();
    const event = result.payload.events?.[0];
    expect(event?.name).toBe(BRAZE_EVENT_CHECKOUT_STARTED);
    expect(event?.external_id).toBe("cust_12345");
  });

  it("passes occurred_at through as ISO 8601 (Braze accepts ISO, not Unix seconds)", () => {
    const ctx = fixtureMapperContext({
      occurred_at: "2026-05-14T12:00:00.500Z",
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.events?.[0]?.time).toBe("2026-05-14T12:00:00.500Z");
  });

  it("builds properties with currency + value (minor → major) + cart_id + num_items + page_url", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const props = result.payload.events?.[0]?.properties;
    expect(props?.currency).toBe("USD");
    expect(props?.value).toBe(199.95);
    expect(props?.cart_id).toBe("cart_42");
    expect(props?.num_items).toBe(3);
    expect(props?.page_url).toBe("https://storefront.example/checkout");
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
    expect(result.payload.events?.[0]?.properties?.value).toBeUndefined();
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
    expect(result.payload.events?.[0]?.properties?.currency).toBe("JPY");
    expect(result.payload.events?.[0]?.properties?.value).toBe(19995);
  });

  it("omits properties entirely when no relevant slot is present and no page_url", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: {
        ...normalized,
        properties: {},
        context: { ...normalized.context, page_url: null },
      },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.events?.[0]?.properties).toBeUndefined();
  });

  it("emits a user_alias entry when only email is present (BJPQSPE5)", () => {
    const ctx = fixtureMapperContext({
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: null,
        email: "buyer@storefront.example",
        email_sha256: null,
        phone: null,
        phone_sha256: null,
      },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const event = result.payload.events?.[0];
    expect(event?.external_id).toBeUndefined();
    expect(event?.user_alias).toEqual({
      alias_label: "email",
      alias_name: "buyer@storefront.example",
    });
  });

  it("skips when no identifier (external_id / email / phone) can be resolved", () => {
    const ctx = fixtureMapperContext({
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
    const result = checkoutStartedMapper(ctx);
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toContain("identifier");
  });
});

describe("paymentApprovedMapper", () => {
  it("returns a purchases[] entry with price + currency + product_id + time", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount_minor: 4999, currency: "USD", order_id: "ord_1" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.purchases).toHaveLength(1);
    expect(result.payload.events).toBeUndefined();
    expect(result.payload.attributes).toBeUndefined();
    const purchase = result.payload.purchases?.[0];
    expect(purchase?.external_id).toBe("cust_12345");
    expect(purchase?.price).toBe(49.99);
    expect(purchase?.currency).toBe("USD");
    expect(purchase?.product_id).toBe("ord_1");
    expect(purchase?.time).toBe(ctx.normalized.occurred_at);
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });

  it("prefers cart_id over order_id / transaction_id for product_id", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: {
        amount_minor: 4999,
        currency: "USD",
        cart_id: "cart_99",
        order_id: "ord_1",
        transaction_id: "tx_777",
      },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.purchases?.[0]?.product_id).toBe("cart_99");
  });

  it("falls back to transaction_id when cart_id and order_id are absent", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: {
        amount_minor: 4999,
        currency: "USD",
        transaction_id: "tx_777",
      },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.purchases?.[0]?.product_id).toBe("tx_777");
  });

  it("accepts `amount` as an alias for `amount_minor` (legacy producers)", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount: 4999, currency: "USD", cart_id: "cart_99" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.purchases?.[0]?.price).toBe(49.99);
  });

  it("skips when currency is missing (Braze requires currency on every purchase)", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { amount_minor: 4999, cart_id: "cart_99" },
    });
    const result = paymentApprovedMapper(ctx);
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toContain("currency_or_amount");
  });

  it("skips when amount is missing (Braze requires price on every purchase)", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { currency: "USD", cart_id: "cart_99" },
    });
    const result = paymentApprovedMapper(ctx);
    expect(result.kind).toBe("skip");
  });

  it("skips when no product_id can be derived", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      properties: { currency: "USD", amount_minor: 4999 },
    });
    const result = paymentApprovedMapper(ctx);
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toContain("product_id");
  });

  it("emits a user_alias entry when only phone is present (BJPQSPE5)", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: null,
        email: null,
        email_sha256: null,
        phone: "+15555550199",
        phone_sha256: null,
      },
      properties: { amount_minor: 4999, currency: "USD", cart_id: "cart_99" },
    });
    const result = paymentApprovedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const purchase = result.payload.purchases?.[0];
    expect(purchase?.external_id).toBeUndefined();
    expect(purchase?.user_alias).toEqual({
      alias_label: "phone",
      alias_name: "+15555550199",
    });
  });

  it("skips when no identifier can be resolved", () => {
    const ctx = fixtureMapperContext({
      event: "payment.approved",
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
      properties: { amount_minor: 4999, currency: "USD", cart_id: "cart_99" },
    });
    const result = paymentApprovedMapper(ctx);
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toContain("identifier");
  });
});

describe("userIdentifiedMapper", () => {
  it("returns an attributes[] entry with _update_existing_only=false + raw email/phone + language", () => {
    const ctx = fixtureMapperContext({ event: "user.identified" });
    const result = userIdentifiedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.attributes).toHaveLength(1);
    expect(result.payload.events).toBeUndefined();
    expect(result.payload.purchases).toBeUndefined();
    const attribute = result.payload.attributes?.[0];
    expect(attribute?.external_id).toBe("cust_12345");
    expect(attribute?._update_existing_only).toBe(false);
    // Braze consumes RAW email/phone — NOT hashed.
    expect(attribute?.email).toBe("buyer@storefront.example");
    expect(attribute?.phone).toBe("+15555550199");
    expect(attribute?.language).toBe("en-US");
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });

  it("omits email/phone when the normalized identity has them null", () => {
    const ctx = fixtureMapperContext({
      event: "user.identified",
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: "cust_456",
        anonymous_id: null,
        email: null,
        email_sha256: null,
        phone: null,
        phone_sha256: null,
      },
    });
    const result = userIdentifiedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const attribute = result.payload.attributes?.[0];
    expect(attribute?.email).toBeUndefined();
    expect(attribute?.phone).toBeUndefined();
    expect(attribute?.external_id).toBe("cust_456");
  });

  it("emits a user_alias entry when only email is present (BJPQSPE5)", () => {
    const ctx = fixtureMapperContext({
      event: "user.identified",
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: null,
        email: "buyer@storefront.example",
        email_sha256: null,
        phone: null,
        phone_sha256: null,
      },
    });
    const result = userIdentifiedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const attribute = result.payload.attributes?.[0];
    expect(attribute?.external_id).toBeUndefined();
    expect(attribute?.user_alias).toEqual({
      alias_label: "email",
      alias_name: "buyer@storefront.example",
    });
    // Email-only profile still has email/phone slots populated on the
    // attribute body for downstream attribute updates.
    expect(attribute?.email).toBe("buyer@storefront.example");
  });

  it("skips when no identifier can be resolved", () => {
    const ctx = fixtureMapperContext({
      event: "user.identified",
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
    const result = userIdentifiedMapper(ctx);
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toContain("identifier");
  });
});

describe("resolveExternalId", () => {
  it("prefers user_id (canonical customer_id)", () => {
    const normalized = fixtureNormalizedEvent();
    expect(resolveExternalId(normalized)).toBe("cust_12345");
  });

  it("falls back to anonymous_id when user_id is null", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: "anon_xyz",
        email: null,
        email_sha256: null,
        phone: null,
        phone_sha256: null,
      },
    });
    expect(resolveExternalId(normalized)).toBe("anon_xyz");
  });

  it("lowercases + trims the resolved id (Braze documents case-insensitive comparison)", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: "  CUST_UPPER  ",
        anonymous_id: null,
        email: null,
        email_sha256: null,
        phone: null,
        phone_sha256: null,
      },
    });
    expect(resolveExternalId(normalized)).toBe("cust_upper");
  });

  it("returns null when both user_id and anonymous_id are null", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: null,
        email: "buyer@storefront.example",
        email_sha256: null,
        phone: null,
        phone_sha256: null,
      },
    });
    expect(resolveExternalId(normalized)).toBeNull();
  });
});

describe("resolveUserAlias (BJPQSPE5)", () => {
  it("prefers email over phone", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: null,
        email: "buyer@storefront.example",
        email_sha256: null,
        phone: "+15555550199",
        phone_sha256: null,
      },
    });
    expect(resolveUserAlias(normalized)).toEqual({
      alias_label: "email",
      alias_name: "buyer@storefront.example",
    });
  });

  it("falls back to phone when email is null", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: null,
        email: null,
        email_sha256: null,
        phone: "+15555550199",
        phone_sha256: null,
      },
    });
    expect(resolveUserAlias(normalized)).toEqual({
      alias_label: "phone",
      alias_name: "+15555550199",
    });
  });

  it("returns null when neither email nor phone is present", () => {
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
    expect(resolveUserAlias(normalized)).toBeNull();
  });

  it("trims + lowercases the email alias name", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        canonical_customer_id: null,
        profile_id: null,
        user_id: null,
        anonymous_id: null,
        email: "  BUYER@STOREFRONT.example  ",
        email_sha256: null,
        phone: null,
        phone_sha256: null,
      },
    });
    expect(resolveUserAlias(normalized)?.alias_name).toBe("buyer@storefront.example");
  });
});

describe("resolveDeviceId (5UCTHNCR)", () => {
  it("returns null when no app context is present", () => {
    expect(resolveDeviceId(fixtureNormalizedEvent())).toBeNull();
  });

  it("prefers app_idfv over app_gaid over app_idfa", () => {
    const normalized = fixtureNormalizedEvent();
    expect(
      resolveDeviceId({
        ...normalized,
        context: {
          ...normalized.context,
          app_idfv: "ios-vendor-id",
          app_gaid: "android-id",
          app_idfa: "ios-ad-id",
        },
      }),
    ).toBe("ios-vendor-id");
    expect(
      resolveDeviceId({
        ...normalized,
        context: { ...normalized.context, app_gaid: "android-id", app_idfa: "ios-ad-id" },
      }),
    ).toBe("android-id");
    expect(
      resolveDeviceId({
        ...normalized,
        context: { ...normalized.context, app_idfa: "ios-ad-id" },
      }),
    ).toBe("ios-ad-id");
  });

  it("returns null when app context is populated but no device id is set (bundle_id only)", () => {
    const normalized = fixtureNormalizedEvent();
    expect(
      resolveDeviceId({
        ...normalized,
        context: { ...normalized.context, app_bundle_id: "com.example.app" },
      }),
    ).toBeNull();
  });
});

describe("app-channel mapping (5UCTHNCR)", () => {
  it("attaches device_id alongside external_id on checkout events when the envelope is app-source", () => {
    const normalized = fixtureNormalizedEvent();
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
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const event = result.payload.events?.[0];
    expect(event?.external_id).toBe("cust_12345");
    expect(event?.device_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("attaches device_id alongside external_id on purchase entries", () => {
    const normalized = fixtureNormalizedEvent({
      event: "payment.approved",
      properties: { amount_minor: 4999, currency: "USD", cart_id: "cart_42" },
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
    const purchase = result.payload.purchases?.[0];
    expect(purchase?.external_id).toBe("cust_12345");
    expect(purchase?.device_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("attaches device_id alongside external_id on attribute entries", () => {
    const normalized = fixtureNormalizedEvent({ event: "user.identified" });
    const ctx = {
      ...fixtureMapperContext(),
      normalized: {
        ...normalized,
        context: {
          ...normalized.context,
          app_bundle_id: "com.example.storefront",
          app_gaid: "android-advertising-id",
        },
      },
    };
    const result = userIdentifiedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const attribute = result.payload.attributes?.[0];
    expect(attribute?.external_id).toBe("cust_12345");
    expect(attribute?.device_id).toBe("android-advertising-id");
    expect(attribute?._update_existing_only).toBe(false);
  });

  it("uses device_id as the PRIMARY identifier when no external_id / user_alias resolves on an app-source event", () => {
    const ctx = fixtureMapperContext({
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
    const ctxWithApp = {
      ...ctx,
      normalized: {
        ...ctx.normalized,
        context: {
          ...ctx.normalized.context,
          app_bundle_id: "com.example.storefront",
          app_idfv: "device-uuid",
        },
      },
    };
    const result = checkoutStartedMapper(ctxWithApp);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const event = result.payload.events?.[0];
    expect(event?.external_id).toBeUndefined();
    expect(event?.user_alias).toBeUndefined();
    expect(event?.device_id).toBe("device-uuid");
  });

  it("still skips when neither external_id nor user_alias nor device_id resolves", () => {
    const ctx = fixtureMapperContext({
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
    const result = checkoutStartedMapper(ctx);
    expect(result.kind).toBe("skip");
  });

  it("leaves device_id unset on web-source events (no app context)", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.events?.[0]?.device_id).toBeUndefined();
  });
});

describe("CANONICAL_TO_BRAZE_FAMILY", () => {
  it("pins the v1 family matrix", () => {
    expect(CANONICAL_TO_BRAZE_FAMILY["checkout.started"]).toBe("events");
    expect(CANONICAL_TO_BRAZE_FAMILY["payment.approved"]).toBe("purchases");
    expect(CANONICAL_TO_BRAZE_FAMILY["user.identified"]).toBe("attributes");
  });
});

describe("trait attributes (MVKUP64R)", () => {
  function withTraits(traits: Readonly<Record<string, unknown>> | null) {
    return fixtureMapperContext({ traits });
  }

  it("forwards allowlisted traits as Braze custom attributes", () => {
    const result = userIdentifiedMapper(withTraits({ tier: "gold", plan: "pro" }));
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const attribute = result.payload.attributes?.[0] as Record<string, unknown>;
    expect(attribute["tier"]).toBe("gold");
    expect(attribute["plan"]).toBe("pro");
  });

  it("ignores a trait that is not on the allowlist", () => {
    // Braze's attribute space is a namespace an operator curates. A new
    // field in the profile store must not silently create an attribute
    // there — adding one is a decision, made in BRAZE_TRAIT_ATTRIBUTES.
    const result = userIdentifiedMapper(withTraits({ tier: "gold", internal_risk_score: 0.93 }));
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const attribute = result.payload.attributes?.[0] as Record<string, unknown>;
    expect(attribute["internal_risk_score"]).toBeUndefined();
  });

  it("never lets a trait overwrite an identity slot", () => {
    // `email` is set from the canonical identity above. A trait of the same
    // name reaching it would be an identity bug wearing an attribute's
    // clothes, so the reserved list is enforced independently of the
    // allowlist rather than by trusting the allowlist to omit it.
    const base = fixtureNormalizedEvent();
    const result = userIdentifiedMapper(
      fixtureMapperContext({
        traits: { email: "attacker@example.com", external_id: "someone_else" },
      }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const attribute = result.payload.attributes?.[0] as Record<string, unknown>;
    expect(attribute["email"]).toBe(base.identity.email);
    expect(attribute["external_id"]).not.toBe("someone_else");
  });

  it("leaves the attribute untouched when there are no traits", () => {
    const result = userIdentifiedMapper(withTraits(null));
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const attribute = result.payload.attributes?.[0] as Record<string, unknown>;
    expect(attribute["tier"]).toBeUndefined();
  });
});
