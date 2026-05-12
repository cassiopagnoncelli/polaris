import { describe, expect, it } from "vitest";
import { checkoutStartedV1PropertiesSchema } from "../src/events/checkout/started.v1.js";
import { pageViewedV1PropertiesSchema } from "../src/events/page/viewed.v1.js";
import { pageViewedV2PropertiesSchema } from "../src/events/page/viewed.v2.js";
import { checkoutStartedV1Fixture, pageViewedV1Fixture, pageViewedV2Fixture } from "./fixtures.js";

describe("page.viewed v1 (deprecated)", () => {
  it("accepts the v1 fixture properties", () => {
    const result = pageViewedV1PropertiesSchema.safeParse(pageViewedV1Fixture.properties);
    expect(result.success).toBe(true);
  });

  it("rejects v2-style properties (referrer is unknown in v1)", () => {
    // v2 adds new fields, so the v1 schema must NOT silently accept v2.
    // Strict mode is what gives us this signal.
    const result = pageViewedV1PropertiesSchema.safeParse(pageViewedV2Fixture.properties);
    expect(result.success).toBe(false);
  });
});

describe("page.viewed v2 (active)", () => {
  it("accepts the v2 fixture properties", () => {
    const result = pageViewedV2PropertiesSchema.safeParse(pageViewedV2Fixture.properties);
    expect(result.success).toBe(true);
  });

  it("rejects v1-style properties (host was removed)", () => {
    const result = pageViewedV2PropertiesSchema.safeParse(pageViewedV1Fixture.properties);
    expect(result.success).toBe(false);
  });

  it("accepts null search and null referrer", () => {
    const result = pageViewedV2PropertiesSchema.safeParse({
      path: "/",
      search: null,
      title: "Home",
      referrer: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    // referrer is required (nullable, not optional); a missing key is a
    // contract violation we want to catch.
    const result = pageViewedV2PropertiesSchema.safeParse({
      path: "/",
      search: null,
      title: "Home",
    });
    expect(result.success).toBe(false);
  });
});

describe("checkout.started v1 (active)", () => {
  it("accepts the v1 fixture properties", () => {
    const result = checkoutStartedV1PropertiesSchema.safeParse(checkoutStartedV1Fixture.properties);
    expect(result.success).toBe(true);
  });

  it("rejects empty cart items", () => {
    const result = checkoutStartedV1PropertiesSchema.safeParse({
      ...checkoutStartedV1Fixture.properties,
      items: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-ISO currency code", () => {
    const result = checkoutStartedV1PropertiesSchema.safeParse({
      ...checkoutStartedV1Fixture.properties,
      currency: "brl",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative unit_price (minor units must be non-negative)", () => {
    const result = checkoutStartedV1PropertiesSchema.safeParse({
      ...checkoutStartedV1Fixture.properties,
      items: [{ sku: "X", name: "Y", quantity: 1, unit_price: -1 }],
    });
    expect(result.success).toBe(false);
  });
});
