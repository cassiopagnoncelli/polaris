/**
 * Behavioral tests for the meta-capi v1 mappers.
 *
 * Each mapper is pure — no I/O, no clock, no PII reach. Pinned:
 *
 *   - per-event vendor name + dedupe_key=event_id
 *   - event_time conversion (ms → s with floor)
 *   - action_source inference (website vs system_generated)
 *   - user_data shape: em / ph hashed; external_id = sha256(user_id);
 *     anon_id = sha256(anonymous_id); fbp/fbc passthrough when present;
 *     client_ip + ua passthrough
 *   - custom_data: currency/value (minor → major), num_items sum,
 *     order_id from cart_id (checkout) or order_id/transaction_id (payment)
 *   - data_processing_options=["LDU"] on marketing-denied consent
 *
 * @see consumers/meta-capi/v1/src/mapper.ts
 */

import { describe, expect, it } from "vitest";

import { sha256Hex } from "@polaris/shared-destination-normalize";

import {
  buildUserData,
  CANONICAL_TO_META_EVENT,
  checkoutStartedMapper,
  inferActionSource,
  META_EVENT_INITIATE_CHECKOUT,
  META_EVENT_LEAD,
  META_EVENT_PURCHASE,
  paymentApprovedMapper,
  userIdentifiedMapper,
} from "../src/mapper.js";
import { fixtureMapperContext, fixtureNormalizedEvent } from "./fixtures/normalized.js";

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

  it("builds custom_data with currency + value (minor → major) + order_id + num_items", () => {
    const ctx = fixtureMapperContext();
    const result = checkoutStartedMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.payload.custom_data).toEqual({
      currency: "USD",
      value: 199.95,
      num_items: 3,
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

  it("hashes the canonical anonymous_id for anon_id", () => {
    const normalized = fixtureNormalizedEvent();
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

describe("CANONICAL_TO_META_EVENT", () => {
  it("pins the v1 event matrix", () => {
    expect(CANONICAL_TO_META_EVENT["checkout.started"]).toBe(META_EVENT_INITIATE_CHECKOUT);
    expect(CANONICAL_TO_META_EVENT["payment.approved"]).toBe(META_EVENT_PURCHASE);
    expect(CANONICAL_TO_META_EVENT["user.identified"]).toBe(META_EVENT_LEAD);
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
