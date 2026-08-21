/**
 * Test fixtures for the meta-capi v1 mapper / deliverer / integration tests.
 *
 * Builds a realistic `NormalizedEvent` + `MapperContext` +
 * `DelivererContext` without reaching into
 * `@polaris/delivery-normalize`'s actual normalizer — the
 * consumer's mapper accepts whatever shape arrives in
 * `MapperContext.normalized`, so structural-typing a frozen literal is
 * sufficient and faster than running the full normalize pipeline per
 * test.
 */

import type {
  DelivererContext,
  DestinationInstance,
  MapperContext,
} from "@polaris/delivery-destinations";
import type { NormalizedEvent } from "@polaris/delivery-normalize";

import type { MetaCapiPayload } from "../../src/types.js";

/**
 * A destination instance for the runtime under test.
 *
 * `secretValue` is a parameter because the credential now lives ON this row —
 * it used to be a `provider:ref` pointer here and a resolver double in the
 * test, and the value a delivery actually saw came from the double. Tests that
 * exercise a malformed or unusual credential pass it in.
 */
export function fixtureDestinationInstance(
  secretValue = "",
  config: Readonly<Record<string, unknown>> = {},
): DestinationInstance {
  return {
    destination_id: "polaris_dst_test_meta",
    project_id: "storefront",
    environment: "production",
    vendor: "meta-capi",
    instance_label: "meta-ads-main",
    secret_value: secretValue,
    status: "active",
    mode: "live",
    max_concurrency: 4,
    max_rps: 100,
    retry_policy: "standard",
    dead_letter_threshold: 8,
    replay_opt_in: true,
    config,
  };
}

export function fixtureNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const base: NormalizedEvent = {
    traits: null,
    traits_version: null,
    enrichment: { geo: null },
    destination_id: "polaris_dst_test_meta",
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
      email: null,
      email_sha256: "a".repeat(64),
      phone: null,
      phone_sha256: "b".repeat(64),
    },
    best_identity: { kind: "email_sha256", value: "a".repeat(64) },
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

/**
 * `instanceConfig` is the second argument because the mapper now reads one
 * key off `destinations.config` — the geo-fallback switch. A test that does
 * not pass it gets `{}`, which is what an instance nobody has configured
 * looks like and what every pre-FLU7S test assumed.
 */
export function fixtureMapperContext(
  overrides: Partial<NormalizedEvent> = {},
  instanceConfig: Readonly<Record<string, unknown>> = {},
): MapperContext {
  return {
    normalized: fixtureNormalizedEvent(overrides),
    instance: fixtureDestinationInstance("", instanceConfig),
  };
}

/**
 * A `PreparedIdentity` carrying the whole hashed match set, digests keyed
 * by field so a test can name the one it is asserting on.
 *
 * Distinct per field on purpose: eight copies of the same 64 chars would
 * let a mapper that read `first_name_sha256` into `ln` pass every test.
 */
export const FIXTURE_MATCH_DIGESTS = {
  first_name: "1".repeat(64),
  last_name: "2".repeat(64),
  gender: "3".repeat(64),
  birthday: "4".repeat(64),
  city: "5".repeat(64),
  state: "6".repeat(64),
  postal_code: "7".repeat(64),
  country: "8".repeat(64),
} as const;

/** The extended match set as `prepareIdentity` returns it, all eight present. */
export function fixtureExtendedIdentity(
  overrides: Partial<NormalizedEvent["identity"]> = {},
): NormalizedEvent["identity"] {
  return {
    ...fixtureNormalizedEvent().identity,
    first_name: null,
    first_name_sha256: FIXTURE_MATCH_DIGESTS.first_name,
    last_name: null,
    last_name_sha256: FIXTURE_MATCH_DIGESTS.last_name,
    gender: null,
    gender_sha256: FIXTURE_MATCH_DIGESTS.gender,
    birthday: null,
    birthday_sha256: FIXTURE_MATCH_DIGESTS.birthday,
    city: null,
    city_sha256: FIXTURE_MATCH_DIGESTS.city,
    state: null,
    state_sha256: FIXTURE_MATCH_DIGESTS.state,
    postal_code: null,
    postal_code_sha256: FIXTURE_MATCH_DIGESTS.postal_code,
    country: null,
    country_sha256: FIXTURE_MATCH_DIGESTS.country,
    ...overrides,
  };
}

export function fixtureDelivererContext(
  overrides: Partial<DelivererContext<MetaCapiPayload>> = {},
): DelivererContext<MetaCapiPayload> {
  const base: DelivererContext<MetaCapiPayload> = {
    payload: {
      event_name: "InitiateCheckout",
      event_time: Math.floor(Date.parse("2026-05-14T12:00:00.000Z") / 1000),
      event_id: "evt_test_meta_001",
      action_source: "website",
      event_source_url: "https://storefront.example/checkout",
      user_data: {
        em: ["a".repeat(64)],
      },
      custom_data: {
        currency: "USD",
        value: 199.95,
      },
    },
    instance: fixtureDestinationInstance(),
    secret: JSON.stringify({
      pixel_id: "1234567890",
      access_token: "EAAB-test-access-token-xyz123",
    }),
    attempt: 1,
    delivery_key: "polaris_del_test_meta_001",
    // Default: no per-project overrides, which is what a project that has set
    // nothing looks like — and what every project looked like before the
    // cutover. Tests that exercise an override pass one explicitly.
    projectConfig: {},
  };
  return { ...base, ...overrides };
}
