/**
 * Test fixtures for the ga4 v1 mapper / deliverer / integration tests.
 *
 * Builds a realistic `NormalizedEvent` + `MapperContext` +
 * `DelivererContext` without reaching into
 * `@polaris/delivery-normalize`'s actual normalizer — the
 * consumer's mapper accepts whatever shape arrives in
 * `MapperContext.normalized`, so structural-typing a frozen literal is
 * sufficient and faster than running the full normalize pipeline per
 * test.
 */

import type { NormalizedEvent } from "@polaris/delivery-normalize";
import type {
  DelivererContext,
  DestinationInstance,
  MapperContext,
} from "@polaris/delivery-destinations";

import type { Ga4EventPayload, Ga4WrapperFields } from "../../src/types.js";

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
    destination_id: "polaris_dst_test_ga4",
    project_id: "storefront",
    environment: "production",
    vendor: "ga4",
    instance_label: "ga4-analytics-main",
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
      canonical_customer_id: null,
      profile_id: null,
      user_id: "cust_12345",
      anonymous_id: "anon_abc",
      session_id: "sess_9f2c4a",
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
    consent: {
      status: "granted",
      dimensions: [],
      // What the producer declared, for every dimension rather than only
      // the one GA4 gates on. The mapper builds `ad_user_data` /
      // `ad_personalization` from the two it does NOT gate on.
      observed: { analytics: true, marketing: true, personalization: true },
    },
  };
  return { ...base, ...overrides };
}

/**
 * The GA4 session id the fixture's `sess_9f2c4a` hint derives to.
 *
 * A literal rather than a re-computation, deliberately: a test that
 * derives the expectation the same way the code does asserts only that
 * the code is self-consistent, and would keep passing through a change
 * to the derivation — which is exactly the change that must not go
 * unnoticed, because it re-buckets every session GA4 already holds. See
 * `resolveSessionId`.
 */
export const FIXTURE_SESSION_ID = 53_416_520_908_476;

export function fixtureMapperContext(overrides: Partial<NormalizedEvent> = {}): MapperContext {
  return {
    normalized: fixtureNormalizedEvent(overrides),
    instance: fixtureDestinationInstance(),
  };
}

/**
 * A `Ga4WrapperFields` block with the fields every request carries, for
 * tests that build a payload by hand. Overrides merge shallowly.
 */
export function fixtureWrapperFields(overrides: Partial<Ga4WrapperFields> = {}): Ga4WrapperFields {
  return {
    // GA4 reads `client_id` as the browser instance, so the fixture
    // carries the envelope's anonymous_id rather than the per-event
    // delivery_key the deliverer used to synthesize.
    client_id: "anon_int_ga4",
    // The clock, not the fixture date the rest of this file uses, and
    // that difference is deliberate. `timestamp_micros` is withheld when
    // `occurred_at` is more than 72 hours before the SEND, so a pinned
    // date makes every deliverer test exercise the withheld path 72 hours
    // after somebody wrote it — a fixture that rots on a calendar. The
    // default here is the ordinary case (an event delivered promptly);
    // tests of the window pass an explicit age.
    occurred_at_epoch_ms: Date.now(),
    consent: { ad_user_data: "GRANTED", ad_personalization: "GRANTED" },
    ...overrides,
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
      wrapper: fixtureWrapperFields(),
    },
    instance: fixtureDestinationInstance(),
    secret: JSON.stringify({
      measurement_id: "G-TEST123456",
      api_secret: "ga4-test-api-secret-xyz123",
    }),
    attempt: 1,
    delivery_key: "polaris_del_test_ga4_001",
    // Default: no per-project overrides, which is what a project that has set
    // nothing looks like — and what every project looked like before the
    // cutover. Tests that exercise an override pass one explicitly.
    projectConfig: {},
  };
  return { ...base, ...overrides };
}
