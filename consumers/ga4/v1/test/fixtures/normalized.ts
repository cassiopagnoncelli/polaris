/**
 * Test fixtures for the ga4 v1 mapper / deliverer / integration tests.
 *
 * Builds a realistic `NormalizedEvent` + `MapperContext` +
 * `DelivererContext` without reaching into
 * `@polaris/shared-destination-normalize`'s actual normalizer — the
 * consumer's mapper accepts whatever shape arrives in
 * `MapperContext.normalized`, so structural-typing a frozen literal is
 * sufficient and faster than running the full normalize pipeline per
 * test.
 */

import type { NormalizedEvent } from "@polaris/shared-destination-normalize";
import type {
  DelivererContext,
  DestinationInstance,
  MapperContext,
} from "@polaris/shared-destinations";

import type { Ga4EventPayload } from "../../src/types.js";

export function fixtureDestinationInstance(): DestinationInstance {
  return {
    destination_id: "polaris_dst_test_ga4",
    project_id: "storefront",
    environment: "production",
    vendor: "ga4",
    instance_label: "ga4-analytics-main",
    secret_ref: "env:GA4_SECRET",
    status: "active",
    mode: "live",
    max_concurrency: 4,
    max_rps: 100,
    retry_policy: "standard",
    dead_letter_threshold: 8,
  };
}

export function fixtureNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const base: NormalizedEvent = {
    destination_id: "polaris_dst_test_ga4",
    event_id: "evt_01HZZA0YJK0M2R8D8VYV4QH4XR",
    event: "checkout.started",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-14T12:00:00.000Z",
    occurred_at_epoch_ms: Date.parse("2026-05-14T12:00:00.000Z"),
    ingested_at: "2026-05-14T12:00:00.500Z",
    identity: {
      user_id: "cust_12345",
      anonymous_id: "anon_abc",
      email: null,
      email_sha256: null,
      phone: null,
      phone_sha256: null,
    },
    best_identity: { kind: "user_id", value: "cust_12345" },
    context: {
      ip: "203.0.113.42",
      user_agent: "Mozilla/5.0",
      locale: "en-US",
      page_url: "https://storefront.example/checkout",
      page_path: "/checkout",
      page_title: "Checkout",
      page_referrer: "https://storefront.example/cart",
      campaign_source: null,
      campaign_medium: null,
      campaign_name: null,
      campaign_term: null,
      campaign_content: null,
      campaign_click_id: null,
    },
    properties: {
      cart_id: "cart_42",
      total: 19995,
      currency: "USD",
      items: [
        { sku: "sku-1", name: "Widget", quantity: 2, unit_price: 4999 },
        { sku: "sku-2", name: "Gadget", quantity: 1, unit_price: 9997 },
      ],
    },
    consent: { status: "granted", dimensions: [] },
  };
  return { ...base, ...overrides };
}

export function fixtureMapperContext(overrides: Partial<NormalizedEvent> = {}): MapperContext {
  return {
    normalized: fixtureNormalizedEvent(overrides),
    instance: fixtureDestinationInstance(),
  };
}

export function fixtureDelivererContext(
  overrides: Partial<DelivererContext<Ga4EventPayload>> = {},
): DelivererContext<Ga4EventPayload> {
  const base: DelivererContext<Ga4EventPayload> = {
    payload: {
      name: "begin_checkout",
      params: {
        currency: "USD",
        value: 199.95,
      },
    },
    instance: fixtureDestinationInstance(),
    secret: JSON.stringify({
      measurement_id: "G-TEST123456",
      api_secret: "ga4-test-api-secret-xyz123",
    }),
    attempt: 1,
    delivery_key: "polaris_del_test_ga4_001",
  };
  return { ...base, ...overrides };
}
