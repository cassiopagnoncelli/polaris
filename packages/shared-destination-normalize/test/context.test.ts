import { describe, expect, it } from "vitest";

import { flattenContext } from "../src/index.js";

describe("flattenContext", () => {
  it("surfaces page.* and campaign.* into flat keys", () => {
    const flat = flattenContext({
      ip: "203.0.113.10",
      user_agent: "Mozilla/5.0 ...",
      locale: "pt-BR",
      page: {
        url: "https://example.com/checkout",
        path: "/checkout",
        title: "Checkout",
        referrer: "https://example.com/cart",
      },
      campaign: {
        source: "google",
        medium: "cpc",
        name: "spring_sale",
        term: "shoes",
        content: "banner_a",
        click_id: "gclid_abc",
      },
    });
    expect(flat.ip).toBe("203.0.113.10");
    expect(flat.page_url).toBe("https://example.com/checkout");
    expect(flat.page_path).toBe("/checkout");
    expect(flat.page_title).toBe("Checkout");
    expect(flat.page_referrer).toBe("https://example.com/cart");
    expect(flat.campaign_source).toBe("google");
    expect(flat.campaign_medium).toBe("cpc");
    expect(flat.campaign_name).toBe("spring_sale");
    expect(flat.campaign_term).toBe("shoes");
    expect(flat.campaign_content).toBe("banner_a");
    expect(flat.campaign_click_id).toBe("gclid_abc");
  });

  it("is null-safe at every level", () => {
    expect(flattenContext(null).ip).toBeNull();
    expect(flattenContext(undefined).page_url).toBeNull();
    expect(flattenContext({ ip: null, user_agent: null, locale: null }).campaign_source).toBeNull();
  });

  it("treats absent page / campaign sub-fields as null (not undefined)", () => {
    const flat = flattenContext({
      ip: "203.0.113.10",
      user_agent: null,
      locale: null,
      page: { url: "https://example.com/" },
      campaign: null,
    });
    expect(flat.page_url).toBe("https://example.com/");
    expect(flat.page_path).toBeNull();
    expect(flat.page_referrer).toBeNull();
    expect(flat.campaign_source).toBeNull();
  });

  it("returns a non-undefined value for every documented key", () => {
    const flat = flattenContext(null);
    const expectedKeys = [
      "ip",
      "user_agent",
      "locale",
      "page_url",
      "page_path",
      "page_title",
      "page_referrer",
      "campaign_source",
      "campaign_medium",
      "campaign_name",
      "campaign_term",
      "campaign_content",
      "campaign_click_id",
    ] as const;
    for (const key of expectedKeys) {
      expect(flat[key]).toBeNull();
    }
  });
});
