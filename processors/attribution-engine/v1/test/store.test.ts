/**
 * In-memory touchpoint-store tests for attribution-engine v1.
 */

import { describe, expect, it } from "vitest";

import {
  buildDeltaRecord,
  buildFirstObservationRecord,
  buildSameTupleRecord,
  InMemoryTouchpointStore,
} from "../src/store.js";
import type { CampaignTuple, TouchpointChainRecord } from "../src/transform.js";

const FULL_CAMPAIGN: CampaignTuple = {
  source: "google",
  medium: "cpc",
  name: "summer_sale_2026",
  term: "running shoes",
  content: "ad_variant_A",
  click_id: "gclid_abc123",
};

const ALT_CAMPAIGN: CampaignTuple = {
  source: "facebook",
  medium: "social",
  name: "summer_sale_2026",
  term: null,
  content: null,
  click_id: "fbclid_xyz456",
};

function makeRecord(overrides: Partial<TouchpointChainRecord> = {}): TouchpointChainRecord {
  return {
    project_id: "checkout",
    environment: "production",
    primary_identifier_kind: "anonymous_id",
    primary_identifier_value: "anon_X",
    first_touchpoint_id: "tp_first",
    first_touchpoint_tuple: FULL_CAMPAIGN,
    first_source_event_id: "evt_first",
    first_observed_at: "2026-05-14T10:00:00.000Z",
    last_touchpoint_id: "tp_first",
    last_touchpoint_tuple: FULL_CAMPAIGN,
    last_source_event_id: "evt_first",
    last_observed_at: "2026-05-14T10:00:00.000Z",
    touchpoint_count: 1,
    ...overrides,
  };
}

describe("InMemoryTouchpointStore", () => {
  it("set/get round-trips a record", () => {
    const store = new InMemoryTouchpointStore();
    const rec = makeRecord();
    store.set("k", rec);
    expect(store.get("k")).toEqual(rec);
  });

  it("delete removes a key", () => {
    const store = new InMemoryTouchpointStore();
    store.set("k", makeRecord());
    store.delete("k");
    expect(store.get("k")).toBeUndefined();
  });

  it("size tracks the number of active records", () => {
    const store = new InMemoryTouchpointStore();
    expect(store.size()).toBe(0);
    store.set("a", makeRecord());
    store.set("b", makeRecord({ primary_identifier_value: "anon_Y" }));
    expect(store.size()).toBe(2);
    store.delete("a");
    expect(store.size()).toBe(1);
  });

  it("snapshot returns the active records", () => {
    const store = new InMemoryTouchpointStore();
    store.set("a", makeRecord());
    store.set("b", makeRecord({ primary_identifier_value: "anon_Y" }));
    const snapshot = store.snapshot();
    expect(snapshot).toHaveLength(2);
  });
});

describe("buildFirstObservationRecord", () => {
  it("opens a record with touchpoint_count=1 and matched first/last slots", () => {
    const opened = buildFirstObservationRecord({
      project_id: "checkout",
      environment: "production",
      primary_identifier_kind: "anonymous_id",
      primary_identifier_value: "anon_X",
      touchpoint_id: "tp_aaaaa",
      campaign: FULL_CAMPAIGN,
      source_event_id: "evt_1",
      observed_at: "2026-05-14T12:00:00.000Z",
    });
    expect(opened.first_touchpoint_id).toBe("tp_aaaaa");
    expect(opened.last_touchpoint_id).toBe("tp_aaaaa");
    expect(opened.first_touchpoint_tuple).toEqual(FULL_CAMPAIGN);
    expect(opened.last_touchpoint_tuple).toEqual(FULL_CAMPAIGN);
    expect(opened.touchpoint_count).toBe(1);
    expect(opened.first_observed_at).toBe("2026-05-14T12:00:00.000Z");
    expect(opened.last_observed_at).toBe("2026-05-14T12:00:00.000Z");
  });
});

describe("buildSameTupleRecord", () => {
  it("bumps touchpoint_count and last_observed_at while preserving the canonical touchpoint identity", () => {
    const prior = makeRecord({ touchpoint_count: 3 });
    const next = buildSameTupleRecord({
      prior,
      observed_at: "2026-05-14T13:00:00.000Z",
    });
    expect(next.touchpoint_count).toBe(4);
    expect(next.last_observed_at).toBe("2026-05-14T13:00:00.000Z");
    // Touchpoint identity unchanged.
    expect(next.last_touchpoint_id).toBe(prior.last_touchpoint_id);
    expect(next.last_touchpoint_tuple).toEqual(prior.last_touchpoint_tuple);
    expect(next.last_source_event_id).toBe(prior.last_source_event_id);
    // First-touch slot stays put.
    expect(next.first_touchpoint_id).toBe(prior.first_touchpoint_id);
    expect(next.first_observed_at).toBe(prior.first_observed_at);
  });
});

describe("buildDeltaRecord", () => {
  it("advances the last-touch slot, preserves the first-touch slot, increments the count", () => {
    const prior = makeRecord({ touchpoint_count: 2 });
    const next = buildDeltaRecord({
      prior,
      touchpoint_id: "tp_delta",
      campaign: ALT_CAMPAIGN,
      source_event_id: "evt_delta",
      observed_at: "2026-05-14T14:00:00.000Z",
    });
    // Last-touch slot advanced.
    expect(next.last_touchpoint_id).toBe("tp_delta");
    expect(next.last_touchpoint_tuple).toEqual(ALT_CAMPAIGN);
    expect(next.last_source_event_id).toBe("evt_delta");
    expect(next.last_observed_at).toBe("2026-05-14T14:00:00.000Z");
    // First-touch slot preserved.
    expect(next.first_touchpoint_id).toBe(prior.first_touchpoint_id);
    expect(next.first_touchpoint_tuple).toEqual(prior.first_touchpoint_tuple);
    expect(next.first_source_event_id).toBe(prior.first_source_event_id);
    expect(next.first_observed_at).toBe(prior.first_observed_at);
    expect(next.touchpoint_count).toBe(3);
  });
});
