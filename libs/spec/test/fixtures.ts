import type { Envelope } from "../src/envelope/envelope.js";

/**
 * Golden fixtures used across the test suite. They double as developer
 * examples: when a new event lands, copy the shape here first, then make
 * the schema validate it.
 */

const BASE_ENVELOPE_HEAD = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  project_id: "internal-app",
  environment: "production",
  occurred_at: "2026-05-11T12:00:00.000Z",
  ingested_at: "2026-05-11T12:00:01.120Z",
  source: {
    type: "browser",
    id: "web-sdk",
    sdk: "web",
    sdk_version: "1.0.0",
  },
  identity: {
    anonymous_id: "anon_abc",
    session_id: "sess_xyz",
    customer_id: null,
    device_id: null,
  },
  context: {
    ip: "203.0.113.10",
    user_agent: "Mozilla/5.0 ...",
    locale: "pt-BR",
    page: {
      url: "https://example.com/products/sku-1",
      path: "/products/sku-1",
      title: "Product SKU-1",
      referrer: "https://example.com/",
    },
    campaign: null,
  },
} as const;

/** Valid `page.viewed` v1 (deprecated) event. */
export const pageViewedV1Fixture = {
  ...BASE_ENVELOPE_HEAD,
  event: "page.viewed",
  schema_version: 1,
  properties: {
    path: "/products/sku-1?ref=email",
    title: "Product SKU-1",
    host: "example.com",
  },
} as const satisfies Envelope;

/** Valid `page.viewed` v2 (active) event. */
export const pageViewedV2Fixture = {
  ...BASE_ENVELOPE_HEAD,
  event: "page.viewed",
  schema_version: 2,
  properties: {
    path: "/products/sku-1",
    search: "?ref=email",
    title: "Product SKU-1",
    referrer: "https://example.com/",
  },
} as const satisfies Envelope;

/** Valid `checkout.started` v1 (active) event with two cart lines. */
export const checkoutStartedV1Fixture = {
  ...BASE_ENVELOPE_HEAD,
  event_id: "018f1b9e-9c20-7b12-9a2e-0e2f88d8f552",
  event: "checkout.started",
  schema_version: 1,
  source: { ...BASE_ENVELOPE_HEAD.source, type: "backend", id: "checkout-api", sdk: "node" },
  identity: {
    ...BASE_ENVELOPE_HEAD.identity,
    customer_id: "cus_123",
  },
  properties: {
    cart_id: "cart_001",
    total: 24990,
    currency: "BRL",
    items: [
      {
        sku: "SKU-1",
        name: "Coffee Beans 250g",
        quantity: 1,
        unit_price: 4990,
      },
      {
        sku: "SKU-2",
        name: "Espresso Cup",
        quantity: 2,
        unit_price: 10000,
      },
    ],
    coupon_code: "WELCOME10",
  },
} as const satisfies Envelope;
