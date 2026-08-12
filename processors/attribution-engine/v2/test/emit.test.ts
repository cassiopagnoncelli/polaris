/**
 * Tests for the canonical envelope builders in `src/emit.ts`. The runtime
 * relies on these builders to stamp the dual-shape processor metadata
 * (nested `processor` block + flat `processor_name` / `processor_version`)
 * so ClickHouse Kafka Engine ingestion reads both forms.
 *
 * Acceptance criterion coverage: "Output events include processor
 * metadata."
 */

import { describe, expect, it } from "vitest";

import {
  buildFirstTouchAssignedEnvelope,
  buildLastTouchAssignedEnvelope,
  buildTouchpointCapturedEnvelope,
  type FirstTouchAssignedProperties,
  type LastTouchAssignedProperties,
  type TouchpointCapturedProperties,
} from "../src/emit.js";
import { type CampaignTuple, PROCESSOR_NAME, PROCESSOR_VERSION } from "../src/transform.js";
import type { AnalyticsEventEnvelope } from "../src/types.js";

const RAW: AnalyticsEventEnvelope = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  event: "page.viewed",
  schema_version: 1,
  project_id: "storefront",
  environment: "production",
  occurred_at: "2026-05-14T12:00:00.000Z",
  ingested_at: "2026-05-14T12:00:00.250Z",
  source: { type: "browser", id: "storefront-web", sdk: "web", sdk_version: "1.0.0" },
  identity: {
    anonymous_id: "anon-1",
    session_id: null,
    customer_id: "cus_1",
    device_id: null,
  },
  context: {
    ip: null,
    user_agent: null,
    locale: null,
    page: null,
    campaign: {
      source: "google",
      medium: "cpc",
      name: "summer_sale_2026",
      term: null,
      content: null,
      click_id: "gclid_abc",
    },
  },
  properties: {},
};

const CAMPAIGN: CampaignTuple = {
  source: "google",
  medium: "cpc",
  name: "summer_sale_2026",
  term: null,
  content: null,
  click_id: "gclid_abc",
};

const NOW = () => new Date("2026-05-14T12:00:00.600Z");

const TOUCHPOINT_PROPS: TouchpointCapturedProperties = {
  touchpoint_id: "tp_deadbeefdeadbeefdeadbeefdeadbeef",
  primary_identifier_kind: "customer_id",
  primary_identifier_value: "cus_1",
  campaign: CAMPAIGN,
  source_event_id: RAW.event_id,
  observed_at: RAW.occurred_at,
  run_id: "run_test_1",
};

const FIRST_PROPS: FirstTouchAssignedProperties = {
  ...TOUCHPOINT_PROPS,
};

const LAST_PROPS: LastTouchAssignedProperties = {
  ...TOUCHPOINT_PROPS,
  previous_touchpoint_id: null,
};

describe("buildTouchpointCapturedEnvelope", () => {
  it("emits an attribution.touchpoint_captured envelope with the dual-shape processor stamp", () => {
    const env = buildTouchpointCapturedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000001",
      now: NOW,
      run_id: "run_test_1",
      properties: TOUCHPOINT_PROPS,
    });
    expect(env.event).toBe("attribution.touchpoint_captured");
    expect(env.schema_version).toBe(1);
    // Both nested + flat processor stamp shapes.
    expect(env.processor_name).toBe(PROCESSOR_NAME);
    expect(env.processor_version).toBe(PROCESSOR_VERSION);
    expect(env.processor.name).toBe(PROCESSOR_NAME);
    expect(env.processor.version).toBe(PROCESSOR_VERSION);
    expect(env.processor.ran_at).toBe("2026-05-14T12:00:00.600Z");
    expect(env.processor.run_id).toBe("run_test_1");
  });

  it("inherits project_id, environment, occurred_at, identity from the source raw event", () => {
    const env = buildTouchpointCapturedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000002",
      now: NOW,
      run_id: "run_test_1",
      properties: TOUCHPOINT_PROPS,
    });
    expect(env.project_id).toBe(RAW.project_id);
    expect(env.environment).toBe(RAW.environment);
    expect(env.occurred_at).toBe(RAW.occurred_at);
    expect(env.identity).toEqual({
      anonymous_id: "anon-1",
      session_id: null,
      customer_id: "cus_1",
      device_id: null,
    });
  });

  it("uses the internal source marker and an empty canonical context", () => {
    const env = buildTouchpointCapturedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000003",
      now: NOW,
      run_id: "run_test_1",
      properties: TOUCHPOINT_PROPS,
    });
    expect(env.source.type).toBe("internal");
    expect(env.source.id).toBe(PROCESSOR_NAME);
    expect(env.context.ip).toBeNull();
    expect(env.context.user_agent).toBeNull();
    expect(env.context.locale).toBeNull();
    expect(env.context.page).toBeNull();
    expect(env.context.campaign).toBeNull();
  });

  it("stamps the explicit event_id parameter (runtime supplies a fresh UUIDv7)", () => {
    const env = buildTouchpointCapturedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000004",
      now: NOW,
      run_id: "run_test_1",
      properties: TOUCHPOINT_PROPS,
    });
    expect(env.event_id).toBe("018f1b9e-7b50-7b12-aaaa-000000000004");
  });

  it("emits the touchpoint property payload verbatim", () => {
    const env = buildTouchpointCapturedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000005",
      now: NOW,
      run_id: "run_test_1",
      properties: TOUCHPOINT_PROPS,
    });
    expect(env.properties).toEqual(TOUCHPOINT_PROPS);
  });
});

describe("buildFirstTouchAssignedEnvelope", () => {
  it("emits the first-touch event with the same property shape as touchpoint_captured", () => {
    const env = buildFirstTouchAssignedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000010",
      now: NOW,
      run_id: "run_test_1",
      properties: FIRST_PROPS,
    });
    expect(env.event).toBe("attribution.first_touch_assigned");
    expect(env.properties).toEqual(FIRST_PROPS);
  });
});

describe("buildLastTouchAssignedEnvelope", () => {
  it("emits the last-touch event with a previous_touchpoint_id property", () => {
    const env = buildLastTouchAssignedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000011",
      now: NOW,
      run_id: "run_test_1",
      properties: LAST_PROPS,
    });
    expect(env.event).toBe("attribution.last_touch_assigned");
    const props = env.properties as LastTouchAssignedProperties;
    expect(props.previous_touchpoint_id).toBeNull();
  });

  it("preserves a non-null previous_touchpoint_id when supplied", () => {
    const env = buildLastTouchAssignedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000012",
      now: NOW,
      run_id: "run_test_1",
      properties: { ...LAST_PROPS, previous_touchpoint_id: "tp_prior" },
    });
    const props = env.properties as LastTouchAssignedProperties;
    expect(props.previous_touchpoint_id).toBe("tp_prior");
  });
});

describe("emit determinism", () => {
  it("produces a deterministic envelope across two calls with the same inputs", () => {
    const e1 = buildTouchpointCapturedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000020",
      now: NOW,
      run_id: "run_test_1",
      properties: TOUCHPOINT_PROPS,
    });
    const e2 = buildTouchpointCapturedEnvelope({
      raw: RAW,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000020",
      now: NOW,
      run_id: "run_test_1",
      properties: TOUCHPOINT_PROPS,
    });
    expect(JSON.stringify(e1)).toBe(JSON.stringify(e2));
  });
});
