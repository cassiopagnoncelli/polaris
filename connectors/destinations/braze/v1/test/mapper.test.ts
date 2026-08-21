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
 *   - the standard profile fields (dob, gender, country, home_city,
 *     first_name, last_name, image_url) and which side of the normalized
 *     event each is read from
 *   - `location_from_geo`: off by default, traits ahead of geo when on
 *   - the widened custom-attribute allowlist, including the flattened
 *     company bag
 *
 * @see connectors/destinations/braze/v1/src/mapper.ts
 */

import type { NormalizedEvent } from "@polaris/delivery-normalize";
import { describe, expect, it } from "vitest";

import {
  BRAZE_EVENT_CHECKOUT_STARTED,
  BRAZE_TRAIT_ATTRIBUTES,
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

describe("standard profile attributes (STHB0)", () => {
  /**
   * A `user.identified` context whose profile carries the pinned traits.
   *
   * Both halves are supplied, because the production shape has both and the
   * mapper reads each from a different one: the trait bag keeps the
   * producer's spelling, and the identity block carries what `person.ts` /
   * `address.ts` canonicalized out of the same values. A fixture that set
   * only one would let a mapper reading the wrong side still pass.
   */
  function identified(
    traits: Readonly<Record<string, unknown>> | null,
    identity: Partial<NormalizedEvent["identity"]> = {},
    extras: Partial<NormalizedEvent> = {},
    instanceConfig: Readonly<Record<string, unknown>> = {},
  ) {
    const base = fixtureNormalizedEvent();
    return fixtureMapperContext(
      {
        event: "user.identified",
        traits,
        identity: { ...base.identity, ...identity },
        ...extras,
      },
      instanceConfig,
    );
  }

  function attributeOf(ctx: ReturnType<typeof identified>): Record<string, unknown> {
    const result = userIdentifiedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    return result.payload.attributes?.[0] as Record<string, unknown>;
  }

  it("writes dob, gender, country and home_city from the trait snapshot", () => {
    const attribute = attributeOf(
      identified(
        { first_name: "José", last_name: "O'Brien", address: { city: "Menlo Park" } },
        { birthday: "19900320", gender: "f", country: "br" },
      ),
    );
    // Braze's dob is YYYY-MM-DD; the canonical form every other vendor
    // hashes is YYYYMMDD, and this is the same day reformatted rather than
    // a second reading of the trait.
    expect(attribute["dob"]).toBe("1990-03-20");
    expect(attribute["gender"]).toBe("F");
    // ISO-3166-1 alpha-2, upper case, whichever source answered.
    expect(attribute["country"]).toBe("BR");
    // The city NAME, not the hash-canonical "menlopark".
    expect(attribute["home_city"]).toBe("Menlo Park");
  });

  it("keeps the producer's spelling for the name and avatar slots", () => {
    // `identity.first_name` is "josé" — lowercased with punctuation
    // stripped, because it is a hash input. A Braze profile built from it
    // would greet "O'Brien" as "obrien".
    const attribute = attributeOf(
      identified(
        {
          first_name: "José",
          last_name: "O'Brien",
          avatar: "https://cdn.storefront.example/a.png",
        },
        { first_name: "josé", last_name: "obrien" },
      ),
    );
    expect(attribute["first_name"]).toBe("José");
    expect(attribute["last_name"]).toBe("O'Brien");
    expect(attribute["image_url"]).toBe("https://cdn.storefront.example/a.png");
  });

  it("omits gender when the canonical form refused the producer's value", () => {
    // `person.ts` maps onto `m` / `f` and refuses the rest, so Braze's `O`
    // and `P` are unreachable — an omitted slot rather than a guessed one.
    const attribute = attributeOf(identified({ gender: "non-binary" }, { gender: null }));
    expect(attribute["gender"]).toBeUndefined();
  });

  it("omits dob when the identity carries no birthday", () => {
    const attribute = attributeOf(identified({ tier: "gold" }));
    expect(attribute["dob"]).toBeUndefined();
  });

  it("writes none of them for an envelope with no traits", () => {
    const attribute = attributeOf(identified(null));
    expect(attribute["dob"]).toBeUndefined();
    expect(attribute["gender"]).toBeUndefined();
    expect(attribute["country"]).toBeUndefined();
    expect(attribute["home_city"]).toBeUndefined();
    expect(attribute["first_name"]).toBeUndefined();
  });
});

describe("location_from_geo (STHB0)", () => {
  const GEO = {
    geo: { country: "PT", region: "Lisboa", city: "Lisbon", source: "maxmind-city:1" },
  } satisfies NormalizedEvent["enrichment"];

  function attributeOf(
    traits: Readonly<Record<string, unknown>> | null,
    identity: Partial<NormalizedEvent["identity"]>,
    instanceConfig: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const base = fixtureNormalizedEvent();
    const result = userIdentifiedMapper(
      fixtureMapperContext(
        {
          event: "user.identified",
          traits,
          identity: { ...base.identity, ...identity },
          enrichment: GEO,
        },
        instanceConfig,
      ),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    return result.payload.attributes?.[0] as Record<string, unknown>;
  }

  it("is off by default — geo never reaches the profile unasked", () => {
    // Geo is where the DEVICE was. Defaulting it into `home_city` would
    // move a traveller out of a campaign for a week and back after.
    const attribute = attributeOf({ tier: "gold" }, {}, {});
    expect(attribute["country"]).toBeUndefined();
    expect(attribute["home_city"]).toBeUndefined();
  });

  it("fills country and home_city from geo when the instance opts in", () => {
    const attribute = attributeOf({ tier: "gold" }, {}, { location_from_geo: true });
    expect(attribute["country"]).toBe("PT");
    expect(attribute["home_city"]).toBe("Lisbon");
  });

  it("lets the profile's own address win over geo", () => {
    const attribute = attributeOf(
      { address: { city: "Menlo Park" } },
      { country: "br" },
      { location_from_geo: true },
    );
    expect(attribute["country"]).toBe("BR");
    expect(attribute["home_city"]).toBe("Menlo Park");
  });

  it("treats a non-boolean switch value as off", () => {
    const attribute = attributeOf({ tier: "gold" }, {}, { location_from_geo: "yes" });
    expect(attribute["country"]).toBeUndefined();
  });

  it("drops a geo country that is not an alpha-2 code", () => {
    // The envelope's geo slot is capped at eight characters, not two. A
    // country is the field where a guess puts a person in another
    // country's audience.
    const base = fixtureNormalizedEvent();
    const result = userIdentifiedMapper(
      fixtureMapperContext(
        {
          event: "user.identified",
          traits: { tier: "gold" },
          identity: base.identity,
          enrichment: { geo: { country: "PRT", region: null, city: null, source: "s" } },
        },
        { location_from_geo: true },
      ),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const attribute = result.payload.attributes?.[0] as Record<string, unknown>;
    expect(attribute["country"]).toBeUndefined();
  });
});

describe("the widened trait allowlist (STHB0)", () => {
  function attributeOf(traits: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const result = userIdentifiedMapper(fixtureMapperContext({ event: "user.identified", traits }));
    if (result.kind !== "mapped") throw new Error("expected mapped");
    return result.payload.attributes?.[0] as Record<string, unknown>;
  }

  it("forwards the pinned slots Braze does not reserve", () => {
    const attribute = attributeOf({
      name: "José O'Brien",
      title: "Head of Widgets",
      username: "jobrien",
      website: "https://jobrien.example",
      created_at: "2024-01-05T09:30:00-03:00",
    });
    expect(attribute["name"]).toBe("José O'Brien");
    expect(attribute["title"]).toBe("Head of Widgets");
    expect(attribute["username"]).toBe("jobrien");
    expect(attribute["website"]).toBe("https://jobrien.example");
    expect(attribute["created_at"]).toBe("2024-01-05T09:30:00-03:00");
  });

  it("flattens the company bag rather than sending a nested object", () => {
    // Braze's nested custom attributes are an account feature, not a
    // given; a flat `company_name` is accepted by every workspace.
    const attribute = attributeOf({
      company: { id: "co_42", name: "Widget Co", industry: "Retail", employee_count: 120 },
    });
    expect(attribute["company"]).toBeUndefined();
    expect(attribute["company_id"]).toBe("co_42");
    expect(attribute["company_name"]).toBe("Widget Co");
    expect(attribute["company_industry"]).toBe("Retail");
    expect(attribute["company_employee_count"]).toBe(120);
  });

  it("ignores a company key nobody pinned", () => {
    const attribute = attributeOf({ company: { internal_segment: "whale" } });
    expect(attribute["internal_segment"]).toBeUndefined();
    expect(attribute["company_internal_segment"]).toBeUndefined();
  });

  it("survives a company trait that is not an object", () => {
    const attribute = attributeOf({ company: "Widget Co", tier: "gold" });
    expect(attribute["company_name"]).toBeUndefined();
    expect(attribute["tier"]).toBe("gold");
  });

  it("never targets a name Braze owns", () => {
    // The guard is a runtime `continue`, so a reserved target would be
    // silently dropped rather than caught. This is what catches it.
    const reserved = new Set([
      "external_id",
      "user_alias",
      "braze_id",
      "device_id",
      "_update_existing_only",
      "country",
      "dob",
      "email",
      "first_name",
      "gender",
      "home_city",
      "image_url",
      "language",
      "last_name",
      "phone",
      "push_tokens",
      "time_zone",
    ]);
    for (const name of Object.values(BRAZE_TRAIT_ATTRIBUTES)) {
      expect(reserved.has(name), `${name} is a Braze standard field`).toBe(false);
    }
  });
});
