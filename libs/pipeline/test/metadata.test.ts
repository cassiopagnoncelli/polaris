/**
 * Tests for `stampProcessorMetadata`.
 *
 * The helper produces the exact dual-shape envelope (nested `processor`
 * object plus flat `processor_name` / `processor_version` columns) that
 * P4-001 currently emits and the analytics-projector v1 golden fixture
 * locks. These tests pin both shapes and the omission-on-absence behaviour
 * for `consent` / `privacy`.
 */
import { describe, expect, it } from "vitest";

import {
  type CanonicalEnvelopeInput,
  type ProcessorIdentity,
  stampProcessorMetadata,
} from "../src/index.js";

const IDENTITY: ProcessorIdentity = {
  name: "analytics-projector",
  version: "v1",
};

const RAN_AT_ISO = "2026-05-12T12:00:02.000Z";
const fixedNow = (): Date => new Date(RAN_AT_ISO);

function buildEnvelope(overrides: Partial<CanonicalEnvelopeInput> = {}): CanonicalEnvelopeInput {
  const base: CanonicalEnvelopeInput = {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "payment.approved",
    schema_version: 1,
    project_id: "checkout",
    environment: "production",
    occurred_at: "2026-05-12T12:00:00.000Z",
    ingested_at: "2026-05-12T12:00:01.120Z",
    source: { type: "backend", id: "payments-api" },
    identity: { anonymous_id: null, customer_id: "cus_123" },
    context: { ip: "203.0.113.10" },
    properties: { payment_id: "pay_1" },
    consent: { analytics: true },
    privacy: { classification: "internal" },
  };
  return { ...base, ...overrides };
}

describe("stampProcessorMetadata", () => {
  it("copies every envelope field verbatim and stamps both nested + flat processor shapes", () => {
    const input = buildEnvelope();
    const out = stampProcessorMetadata(input, { identity: IDENTITY, now: fixedNow });

    // Envelope fields copied unchanged.
    expect(out.event_id).toBe(input.event_id);
    expect(out.event).toBe(input.event);
    expect(out.schema_version).toBe(input.schema_version);
    expect(out.project_id).toBe(input.project_id);
    expect(out.environment).toBe(input.environment);
    expect(out.occurred_at).toBe(input.occurred_at);
    expect(out.ingested_at).toBe(input.ingested_at);
    expect(out.source).toEqual(input.source);
    expect(out.identity).toEqual(input.identity);
    expect(out.context).toEqual(input.context);
    expect(out.properties).toEqual(input.properties);
    expect(out.consent).toEqual(input.consent);
    expect(out.privacy).toEqual(input.privacy);

    // Nested processor stamp.
    expect(out.processor).toEqual({
      name: "analytics-projector",
      version: "v1",
      ran_at: RAN_AT_ISO,
    });

    // Flat ClickHouse columns.
    expect(out.processor_name).toBe("analytics-projector");
    expect(out.processor_version).toBe("v1");
  });

  it("attaches run_id to the nested stamp when provided, without leaking to flat columns", () => {
    const input = buildEnvelope();
    const out = stampProcessorMetadata(input, {
      identity: IDENTITY,
      run_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
      now: fixedNow,
    });
    expect(out.processor).toEqual({
      name: "analytics-projector",
      version: "v1",
      ran_at: RAN_AT_ISO,
      run_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
    });
    // Flat columns are scoped to the immutable identity, not the run.
    expect(out.processor_name).toBe("analytics-projector");
    expect(out.processor_version).toBe("v1");
    expect(out).not.toHaveProperty("processor_run_id");
  });

  it("omits consent and privacy when absent from the input", () => {
    const input: CanonicalEnvelopeInput = buildEnvelope();
    const { consent: _c, privacy: _p, ...without } = input;
    void _c;
    void _p;
    const out = stampProcessorMetadata(without, { identity: IDENTITY, now: fixedNow });
    expect(out).not.toHaveProperty("consent");
    expect(out).not.toHaveProperty("privacy");
  });

  it("keeps consent when only consent is present", () => {
    const input = buildEnvelope();
    const { privacy: _p, ...withConsentOnly } = input;
    void _p;
    const out = stampProcessorMetadata(withConsentOnly, { identity: IDENTITY, now: fixedNow });
    expect(out).toHaveProperty("consent");
    expect(out).not.toHaveProperty("privacy");
  });

  it("keeps privacy when only privacy is present", () => {
    const input = buildEnvelope();
    const { consent: _c, ...withPrivacyOnly } = input;
    void _c;
    const out = stampProcessorMetadata(withPrivacyOnly, { identity: IDENTITY, now: fixedNow });
    expect(out).toHaveProperty("privacy");
    expect(out).not.toHaveProperty("consent");
  });

  it("uses the provided now() rather than the host wall clock", () => {
    const fixed = new Date("2099-01-01T00:00:00.000Z");
    const out = stampProcessorMetadata(buildEnvelope(), {
      identity: IDENTITY,
      now: () => fixed,
    });
    expect(out.processor.ran_at).toBe(fixed.toISOString());
  });

  it("defaults now() to the real clock when omitted", () => {
    const before = Date.now();
    const out = stampProcessorMetadata(buildEnvelope(), { identity: IDENTITY });
    const after = Date.now();
    const ranAtMs = new Date(out.processor.ran_at).getTime();
    expect(ranAtMs).toBeGreaterThanOrEqual(before);
    expect(ranAtMs).toBeLessThanOrEqual(after);
  });

  it("round-trips structurally: input -> stamp -> JSON -> parse preserves shape", () => {
    const input = buildEnvelope();
    const stamped = stampProcessorMetadata(input, { identity: IDENTITY, now: fixedNow });
    const round = JSON.parse(JSON.stringify(stamped)) as Record<string, unknown>;
    expect(round["event_id"]).toBe(input.event_id);
    expect(round["processor"]).toEqual({
      name: IDENTITY.name,
      version: IDENTITY.version,
      ran_at: RAN_AT_ISO,
    });
    expect(round["processor_name"]).toBe(IDENTITY.name);
    expect(round["processor_version"]).toBe(IDENTITY.version);
  });
});
