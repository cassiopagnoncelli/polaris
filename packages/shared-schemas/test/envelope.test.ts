import { describe, expect, it } from "vitest";
import { envelopeSchema } from "../src/envelope/envelope.js";
import { pageViewedV2Fixture } from "./fixtures.js";

describe("envelopeSchema", () => {
  it("accepts a fully-stamped canonical event", () => {
    const result = envelopeSchema.safeParse(pageViewedV2Fixture);
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    // The platform envelope is rigid; unknown top-level keys must be rejected
    // even when every required field is present.
    const payload = { ...pageViewedV2Fixture, surprise: "no" };
    const result = envelopeSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const codes = result.error.issues.map((i) => i.code);
      expect(codes).toContain("unrecognized_keys");
    }
  });

  it("rejects unknown nested fields inside identity", () => {
    // Identity, source, and context are also platform-owned and strict.
    const payload = {
      ...pageViewedV2Fixture,
      identity: { ...pageViewedV2Fixture.identity, weird_id: "x" },
    };
    const result = envelopeSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects event names without at least two segments", () => {
    const result = envelopeSchema.safeParse({ ...pageViewedV2Fixture, event: "pageviewed" });
    expect(result.success).toBe(false);
  });

  it("rejects non-snake_case event segments", () => {
    const result = envelopeSchema.safeParse({ ...pageViewedV2Fixture, event: "Page.Viewed" });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer schema_version", () => {
    const result = envelopeSchema.safeParse({ ...pageViewedV2Fixture, schema_version: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects negative schema_version", () => {
    const result = envelopeSchema.safeParse({ ...pageViewedV2Fixture, schema_version: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects timestamps with a timezone offset (must be UTC Z)", () => {
    const result = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      occurred_at: "2026-05-11T12:00:00+02:00",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID event_id", () => {
    const result = envelopeSchema.safeParse({ ...pageViewedV2Fixture, event_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("accepts optional consent and privacy when present", () => {
    const result = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      consent: { analytics: true, marketing: false, personalization: null },
      privacy: { classification: "internal" },
    });
    expect(result.success).toBe(true);
  });
});
