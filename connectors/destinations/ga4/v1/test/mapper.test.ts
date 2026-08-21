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
  GA4_DEFAULT_ENGAGEMENT_TIME_MSEC,
  GA4_ENGAGEMENT_TIME_CONFIG_KEY,
  GA4_EVENT_BEGIN_CHECKOUT,
  GA4_EVENT_LOGIN,
  GA4_EVENT_PAGE_VIEW,
  GA4_EVENT_PURCHASE,
  GA4_EVENT_SIGN_UP,
  GA4_EVENT_SUBSCRIPTION_RENEWED,
  GA4_LOGIN_METHOD_POLARIS,
  pageViewedMapper,
  paymentApprovedMapper,
  resolveAppInstanceId,
  resolveClientId,
  resolveSessionId,
  resolveUserId,
  resolveUserLocation,
  resolveUserProperties,
  signupCompletedMapper,
  subscriptionRenewedMapper,
  userIdentifiedMapper,
} from "../src/mapper.js";
import {
  FIXTURE_SESSION_ID,
  fixtureDestinationInstance,
  fixtureMapperContext,
  fixtureNormalizedEvent,
} from "./fixtures/normalized.js";

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

  it("emits no commerce params when no relevant slot is present", () => {
    const normalized = fixtureNormalizedEvent();
    const ctx = {
      ...fixtureMapperContext(),
      normalized: { ...normalized, properties: {} },
    };
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.currency).toBeUndefined();
    expect(result.payload.params?.value).toBeUndefined();
    expect(result.payload.params?.items).toBeUndefined();
    // `params` itself is never absent now: engagement, session and the
    // page block ride every event whatever the properties say.
    expect(result.payload.params?.engagement_time_msec).toBe(1);
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
    expect(result.payload.params?.method).toBe(GA4_LOGIN_METHOD_POLARIS);
    // Nothing off `properties` reaches the payload; what else is there is
    // the every-event block.
    expect(result.payload.params?.currency).toBeUndefined();
    expect(result.payload.params?.value).toBeUndefined();
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
    expect(result.payload.params).toMatchObject({
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
    expect(result.payload.params?.currency).toBe("USD");
    expect(result.payload.params?.value).toBeUndefined();
    expect(result.payload.params?.transaction_id).toBeUndefined();
  });

  it("emits no renewal params when no relevant slot is present", () => {
    const ctx = fixtureMapperContext({ event: "subscription.renewed", properties: {} });
    const result = subscriptionRenewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.currency).toBeUndefined();
    expect(result.payload.params?.value).toBeUndefined();
    expect(result.payload.params?.transaction_id).toBeUndefined();
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
    expect(result.payload.wrapper.app_instance_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("leaves app_instance_id undefined on the begin_checkout payload when no app context is present", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.app_instance_id).toBeUndefined();
  });
});

describe("CANONICAL_TO_GA4_EVENT", () => {
  it("pins the v1.x event matrix", () => {
    expect(CANONICAL_TO_GA4_EVENT["checkout.started"]).toBe(GA4_EVENT_BEGIN_CHECKOUT);
    expect(CANONICAL_TO_GA4_EVENT["payment.approved"]).toBe(GA4_EVENT_PURCHASE);
    expect(CANONICAL_TO_GA4_EVENT["user.identified"]).toBe(GA4_EVENT_LOGIN);
    expect(CANONICAL_TO_GA4_EVENT["signup.completed"]).toBe(GA4_EVENT_SIGN_UP);
    expect(CANONICAL_TO_GA4_EVENT["subscription.renewed"]).toBe(GA4_EVENT_SUBSCRIPTION_RENEWED);
    expect(CANONICAL_TO_GA4_EVENT["page.viewed"]).toBe(GA4_EVENT_PAGE_VIEW);
  });
});

// ---------------------------------------------------------------------------
// What rides EVERY event (1QKDI)
// ---------------------------------------------------------------------------

describe("session_id", () => {
  it("derives a stable numeric id from the envelope's session hint", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.session_id).toBe(FIXTURE_SESSION_ID);
  });

  it("is a safe integer, so it survives JSON round-tripping exactly", () => {
    const id = resolveSessionId(fixtureNormalizedEvent());
    expect(id).not.toBeNull();
    expect(Number.isSafeInteger(id)).toBe(true);
    // The property that matters on the wire: GA4 stitches by equality.
    expect(JSON.parse(JSON.stringify({ id })).id).toBe(id);
  });

  it("is stable across events of the same session and differs between sessions", () => {
    const a = resolveSessionId(fixtureNormalizedEvent({ event_id: "evt_1" }));
    const b = resolveSessionId(fixtureNormalizedEvent({ event_id: "evt_2" }));
    expect(a).toBe(b);

    const other = resolveSessionId(
      fixtureNormalizedEvent({
        identity: { ...fixtureNormalizedEvent().identity, session_id: "sess_other" },
      }),
    );
    expect(other).not.toBe(a);
  });

  it("is absent when the envelope carries no session (the backend case)", () => {
    const ctx = fixtureMapperContext({
      identity: { ...fixtureNormalizedEvent().identity, session_id: null },
    });
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.session_id).toBeUndefined();
  });
});

describe("engagement_time_msec", () => {
  it("defaults to 1 on every event", () => {
    for (const result of [
      checkoutStartedMapper(fixtureMapperContext()),
      userIdentifiedMapper(fixtureMapperContext({ event: "user.identified" })),
      pageViewedMapper(fixtureMapperContext({ event: "page.viewed" })),
    ]) {
      if (result.kind !== "mapped") throw new Error("expected mapped");
      expect(result.payload.params?.engagement_time_msec).toBe(GA4_DEFAULT_ENGAGEMENT_TIME_MSEC);
    }
  });

  it("takes a per-instance override off destinations.config", () => {
    const result = checkoutStartedMapper({
      normalized: fixtureNormalizedEvent(),
      instance: {
        ...fixtureDestinationInstance(),
        config: { [GA4_ENGAGEMENT_TIME_CONFIG_KEY]: 15_000 },
      },
    });
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.engagement_time_msec).toBe(15_000);
  });

  it("falls back to the default rather than failing on a malformed override", () => {
    for (const configured of ["15000", -1, 1.5, null, {}]) {
      const result = checkoutStartedMapper({
        normalized: fixtureNormalizedEvent(),
        instance: {
          ...fixtureDestinationInstance(),
          config: { [GA4_ENGAGEMENT_TIME_CONFIG_KEY]: configured },
        },
      });
      if (result.kind !== "mapped") throw new Error("expected mapped");
      expect(result.payload.params?.engagement_time_msec, String(configured)).toBe(
        GA4_DEFAULT_ENGAGEMENT_TIME_MSEC,
      );
    }
  });
});

describe("page parameters", () => {
  it("rides every event, not only page_view", () => {
    const result = paymentApprovedMapper(
      fixtureMapperContext({
        event: "payment.approved",
        properties: { amount_minor: 4999, currency: "USD" },
      }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.page_location).toBe("https://storefront.example/checkout");
    expect(result.payload.params?.page_referrer).toBe("https://storefront.example/cart");
    expect(result.payload.params?.page_title).toBe("Checkout");
  });

  it("is absent on an envelope with no page context (a backend event)", () => {
    const base = fixtureNormalizedEvent();
    const result = paymentApprovedMapper(
      fixtureMapperContext({
        event: "payment.approved",
        context: { ...base.context, page_url: null, page_referrer: null, page_title: null },
      }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.params?.page_location).toBeUndefined();
    expect(result.payload.params?.page_referrer).toBeUndefined();
    expect(result.payload.params?.page_title).toBeUndefined();
  });
});

describe("consent", () => {
  it("maps marketing → ad_user_data and personalization → ad_personalization", () => {
    const result = checkoutStartedMapper(
      fixtureMapperContext({
        consent: {
          status: "granted",
          dimensions: [],
          observed: { analytics: true, marketing: false, personalization: true },
        },
      }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    // Denied marketing must reach Google as DENIED — the event still goes
    // (GA4 gates on analytics), and the receiver has to be told.
    expect(result.payload.wrapper.consent).toEqual({
      ad_user_data: "DENIED",
      ad_personalization: "GRANTED",
    });
  });

  it("defaults an absent consent block to GRANTED (ADR-0001 #54, absent-as-true)", () => {
    const result = checkoutStartedMapper(
      fixtureMapperContext({ consent: { status: "granted", dimensions: [] } }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.consent).toEqual({
      ad_user_data: "GRANTED",
      ad_personalization: "GRANTED",
    });
  });
});

describe("user_properties", () => {
  it("forwards the allowlisted traits, including address.country", () => {
    const result = checkoutStartedMapper(
      fixtureMapperContext({
        traits: {
          plan: "enterprise",
          tier: "gold",
          lifecycle_stage: "active",
          address: { country: "US", city: "Denver" },
        },
        traits_version: 4,
      }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.user_properties).toEqual({
      plan: { value: "enterprise" },
      tier: { value: "gold" },
      lifecycle_stage: { value: "active" },
      country: { value: "US" },
    });
  });

  it("is an allowlist: a trait nobody chose does not become a GA4 dimension", () => {
    const result = checkoutStartedMapper(
      fixtureMapperContext({
        traits: { plan: "pro", favourite_colour: "green" },
        traits_version: 1,
      }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.user_properties).toEqual({ plan: { value: "pro" } });
  });

  it("skips structured values rather than stringifying them", () => {
    const result = checkoutStartedMapper(
      fixtureMapperContext({
        traits: { plan: { name: "pro" }, tier: ["gold"] },
        traits_version: 1,
      }),
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.user_properties).toBeUndefined();
  });

  it("is absent when the envelope carries no trait snapshot", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.user_properties).toBeUndefined();
  });

  it("never names a slot GA4 reserves — one would reject the whole request", () => {
    expect(resolveUserProperties(fixtureNormalizedEvent({ traits: { user_id: "u1" } }))).toBeNull();
  });
});

describe("resolveUserId", () => {
  it("prefers the platform's resolution over the producer's claim", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        ...fixtureNormalizedEvent().identity,
        canonical_customer_id: "cust_canonical",
        user_id: "cust_producer",
      },
    });
    expect(resolveUserId(normalized)).toBe("cust_canonical");
  });

  it("falls back to the producer's customer_id when nothing is resolved", () => {
    expect(resolveUserId(fixtureNormalizedEvent())).toBe("cust_12345");
  });

  it("is absent on an anonymous envelope rather than borrowing the anonymous id", () => {
    const normalized = fixtureNormalizedEvent({
      identity: {
        ...fixtureNormalizedEvent().identity,
        canonical_customer_id: null,
        user_id: null,
      },
    });
    expect(resolveUserId(normalized)).toBeNull();
    const result = checkoutStartedMapper({
      normalized,
      instance: fixtureDestinationInstance(),
    });
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.user_id).toBeUndefined();
  });
});

describe("resolveUserLocation", () => {
  it("composes region_id as ISO-3166-2 from country + subdivision code", () => {
    const normalized = fixtureNormalizedEvent({
      enrichment: { geo: { country: "US", region: "CA", city: "Denver", source: "maxmind" } },
    });
    expect(resolveUserLocation(normalized)).toEqual({
      country_id: "US",
      region_id: "US-CA",
      city: "Denver",
    });
  });

  it("drops a subdivision NAME — GA4 rejects one, taking the request with it", () => {
    const normalized = fixtureNormalizedEvent({
      enrichment: { geo: { country: "DE", region: "Bayern", city: "Munich", source: "maxmind" } },
    });
    expect(resolveUserLocation(normalized)).toEqual({ country_id: "DE", city: "Munich" });
  });

  it("is absent when enrichment resolved nothing", () => {
    expect(resolveUserLocation(fixtureNormalizedEvent())).toBeNull();
    const normalized = fixtureNormalizedEvent({
      enrichment: { geo: { country: null, region: null, city: null, source: "no_ip" } },
    });
    expect(resolveUserLocation(normalized)).toBeNull();
  });
});

describe("pageViewedMapper", () => {
  it("returns page_view carrying the page parameters", () => {
    const ctx = fixtureMapperContext({ event: "page.viewed" });
    const result = pageViewedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.name).toBe(GA4_EVENT_PAGE_VIEW);
    expect(result.payload.params?.page_location).toBe("https://storefront.example/checkout");
    expect(result.payload.params?.page_title).toBe("Checkout");
    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });
});

describe("wrapper block", () => {
  it("carries ip_override and user_agent from the flattened context", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.ip_override).toBe("203.0.113.42");
    expect(result.payload.wrapper.user_agent).toBe("Mozilla/5.0");
  });

  it("hands the deliverer occurred_at in milliseconds, not a timestamp decision", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.occurred_at_epoch_ms).toBe(ctx.normalized.occurred_at_epoch_ms);
  });

  it("resolves client_id from the canonical identity, never from the delivery key", () => {
    const result = checkoutStartedMapper(fixtureMapperContext());
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.wrapper.client_id).toBe(resolveClientId(fixtureNormalizedEvent()));
  });
});
