/**
 * Test fixtures for the braze v1 mapper / deliverer / integration tests.
 *
 * Builds a realistic `NormalizedEvent` + `MapperContext` +
 * `DelivererContext` without reaching into
 * `@polaris/delivery-normalize`'s actual normalizer — the
 * consumer's mapper accepts whatever shape arrives in
 * `MapperContext.normalized`, so structural-typing a frozen literal is
 * sufficient and faster than running the full normalize pipeline per
 * test.
 *
 * Braze-specific note: `identityHashing` is OFF at the descriptor level,
 * so the fixture leaves `email_sha256` / `phone_sha256` as null and
 * preserves raw `email` / `phone` on the identity block. The mapper
 * reads from the raw slots; tests assert that contract.
 */

import type { NormalizedEvent } from "@polaris/delivery-normalize";
import type {
  DelivererContext,
  DestinationInstance,
  MapperContext,
} from "@polaris/delivery-destinations";

import type { BrazePayload } from "../../src/types.js";

/**
 * A destination instance for the runtime under test.
 *
 * `secretValue` is a parameter because the credential now lives ON this row —
 * it used to be a `provider:ref` pointer here and a resolver double in the
 * test, and the value a delivery actually saw came from the double. Tests that
 * exercise a malformed or unusual credential pass it in.
 */
export function fixtureDestinationInstance(secretValue = ""): DestinationInstance {
  return {
    destination_id: "polaris_dst_test_braze",
    project_id: "storefront",
    environment: "production",
    vendor: "braze",
    instance_label: "braze-lifecycle-main",
    secret_value: secretValue,
    status: "active",
    mode: "live",
    max_concurrency: 4,
    max_rps: 100,
    retry_policy: "standard",
    dead_letter_threshold: 8,
    replay_opt_in: true,
    config: {},
  };
}

export function fixtureNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const base: NormalizedEvent = {
    traits: null,
    traits_version: null,
    enrichment: { geo: null },
    destination_id: "polaris_dst_test_braze",
    event_id: "evt_01HZZA0YJK0M2R8D8VYV4QH4XR",
    event: "checkout.started",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-14T12:00:00.000Z",
    occurred_at_epoch_ms: Date.parse("2026-05-14T12:00:00.000Z"),
    ingested_at: "2026-05-14T12:00:00.500Z",
    identity: {
      canonical_customer_id: null,
      profile_id: null,
      user_id: "cust_12345",
      anonymous_id: "anon_abc",
      // identityHashing is off — raw email/phone preserved, _sha256 null.
      email: "buyer@storefront.example",
      email_sha256: null,
      phone: "+15555550199",
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
      app_bundle_id: null,
      app_version: null,
      app_namespace: null,
      app_build: null,
      app_idfa: null,
      app_idfv: null,
      app_gaid: null,
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
  overrides: Partial<DelivererContext<BrazePayload>> = {},
): DelivererContext<BrazePayload> {
  const base: DelivererContext<BrazePayload> = {
    payload: {
      events: [
        {
          external_id: "cust_12345",
          name: "checkout_started",
          time: "2026-05-14T12:00:00.000Z",
          properties: {
            currency: "USD",
            value: 199.95,
            cart_id: "cart_42",
            num_items: 3,
            page_url: "https://storefront.example/checkout",
          },
        },
      ],
    },
    instance: fixtureDestinationInstance(),
    secret: JSON.stringify({
      instance: "iad-01",
      api_key: "br-test-api-key-xyz123456",
    }),
    attempt: 1,
    delivery_key: "polaris_del_test_braze_001",
    // Default: no per-project overrides, which is what a project that has set
    // nothing looks like — and what every project looked like before the
    // cutover. Tests that exercise an override pass one explicitly.
    projectConfig: {},
  };
  return { ...base, ...overrides };
}
