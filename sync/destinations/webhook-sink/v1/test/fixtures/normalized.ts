/**
 * Test fixtures for the webhook-sink v1 mapper / deliverer / app tests.
 *
 * Builds a realistic `NormalizedEvent` + `MapperContext` + `DelivererContext`
 * without reaching into `@polaris/shared-destination-normalize`'s actual
 * normalizer — the consumer's mapper accepts whatever shape arrives in
 * `MapperContext.normalized`, so structural-typing a frozen literal is
 * sufficient and faster than running the full normalize pipeline per test.
 */

import type { NormalizedEvent } from "@polaris/shared-destination-normalize";
import type {
  DelivererContext,
  DestinationInstance,
  MapperContext,
} from "@polaris/shared-destinations";

import type { WebhookPayload } from "../../src/types.js";

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
    destination_id: "polaris_dst_test_webhook_1",
    project_id: "storefront",
    environment: "production",
    vendor: "webhook",
    instance_label: "checkout-webhook",
    secret_value: secretValue,
    status: "active",
    mode: "live",
    max_concurrency: 4,
    max_rps: 50,
    retry_policy: "standard",
    dead_letter_threshold: 8,
    replay_opt_in: true,
    config: {},
  };
}

export function fixtureNormalizedEvent(): NormalizedEvent {
  return {
    traits: null,
    traits_version: null,
    enrichment: { geo: null },
    destination_id: "polaris_dst_test_webhook_1",
    event_id: "evt_01HZZA0YJK0M2R8D8VYV4QH4XR",
    event: "payment.approved",
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
      email_sha256: "deadbeef".repeat(8),
      phone: null,
      phone_sha256: null,
    },
    best_identity: { kind: "user_id", value: "cust_12345" },
    context: {
      ip: "203.0.113.42",
      user_agent: "Mozilla/5.0",
      locale: "en-US",
      page_url: null,
      page_path: null,
      page_title: null,
      page_referrer: null,
      campaign_source: null,
      campaign_medium: null,
      campaign_name: null,
      campaign_term: null,
      campaign_content: null,
      utm_id: null,
      timezone: "UTC",
      device_id: null,
      device_type: null,
      app_name: null,
      app_version: null,
      app_build: null,
      os_name: null,
      os_version: null,
      browser_name: null,
      browser_version: null,
      network_carrier: null,
    } as unknown as NormalizedEvent["context"],
    properties: { amount_cents: 1995, currency: "USD" },
    consent: { status: "granted", dimensions: [] },
  };
}

export function fixtureMapperContext(): MapperContext {
  return {
    normalized: fixtureNormalizedEvent(),
    instance: fixtureDestinationInstance(),
  };
}

export function fixtureDelivererContext(
  overrides: Partial<DelivererContext<WebhookPayload>> = {},
): DelivererContext<WebhookPayload> {
  const base: DelivererContext<WebhookPayload> = {
    payload: {
      version: 1,
      delivery: {
        delivery_key: "",
        attempt: 0,
        sent_at: "",
        consumer: {
          vendor: "webhook",
          consumer_version: "v1",
          mapper_version: "v1",
          deliverer_version: "v1",
        },
      },
      event: fixtureNormalizedEvent(),
    },
    instance: fixtureDestinationInstance(),
    secret: "https://hooks.example/receiver",
    attempt: 1,
    delivery_key: "pdk_dst_test_webhook_1_evt_test_001",
    // Default: no per-project overrides, which is what a project that has set
    // nothing looks like — and what every project looked like before the
    // cutover. Tests that exercise an override pass one explicitly.
    projectConfig: {},
  };
  return { ...base, ...overrides };
}
