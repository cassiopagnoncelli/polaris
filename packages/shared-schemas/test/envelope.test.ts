import { describe, expect, it } from "vitest";
import { envelopeSchema, producerEnvelopeSchema } from "../src/envelope/envelope.js";
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

  // ------------------------------------------------------------------
  // Platform-owned resolution blocks (redesign plan §4.4). The point of
  // these is the asymmetry: the canonical envelope carries them, the
  // producer envelope refuses them, and the refusal costs no bespoke code
  // because that schema is `.strict()` and simply does not list them.
  // ------------------------------------------------------------------

  const PROFILE_ID = "019ffe00-0000-7000-8000-000000000001";

  it("accepts a profile block carrying only the ids the identity stage stamps", () => {
    // The shape on `identified.events`: resolved, not yet enriched.
    const result = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      profile: { profile_id: PROFILE_ID, canonical_customer_id: "cus_42" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fully-enriched profile and enrichment block", () => {
    // The shape on `resolved.events`: what a destination consumer sees.
    const result = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      profile: {
        profile_id: PROFILE_ID,
        canonical_customer_id: "cus_42",
        traits: { plan: "pro", ltv: 1280 },
        traits_version: 7,
      },
      enrichment: { geo: { country: "BR", region: "SP", city: "Sao Paulo", source: "maxmind" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null profile for an event with no resolvable identity", () => {
    // §4.2 step 1: the spine stamps `profile: null` and carries on rather
    // than dropping the event.
    const result = envelopeSchema.safeParse({ ...pageViewedV2Fixture, profile: null });
    expect(result.success).toBe(true);
  });

  it("accepts traits: null for an over-cap snapshot", () => {
    // The size guard nulls the snapshot; it never drops the event, and the
    // profile_id still travels.
    const result = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      profile: {
        profile_id: PROFILE_ID,
        canonical_customer_id: null,
        traits: null,
        traits_version: 3,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a geo miss, which still records its provenance", () => {
    const result = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      enrichment: { geo: null },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a profile block without profile_id", () => {
    const result = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      profile: { canonical_customer_id: "cus_42" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields inside the platform blocks", () => {
    const withProfileExtra = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      profile: { profile_id: PROFILE_ID, canonical_customer_id: null, sneaky: true },
    });
    expect(withProfileExtra.success).toBe(false);

    const withGeoExtra = envelopeSchema.safeParse({
      ...pageViewedV2Fixture,
      enrichment: {
        geo: { country: "BR", region: null, city: null, source: "maxmind", lat: 1 },
      },
    });
    expect(withGeoExtra.success).toBe(false);
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

describe("producerEnvelopeSchema", () => {
  // Producers send the pre-stamp shape, so build one by dropping the
  // fields the ingester stamps.
  const {
    project_id: _p,
    environment: _e,
    ingested_at: _i,
    ...producerFixture
  } = pageViewedV2Fixture as Record<string, unknown> as {
    project_id: unknown;
    environment: unknown;
    ingested_at: unknown;
    [k: string]: unknown;
  };

  it("accepts the producer shape", () => {
    expect(producerEnvelopeSchema.safeParse(producerFixture).success).toBe(true);
  });

  it("rejects a producer-supplied profile block", () => {
    // A forged profile must not reach the spine. `.strict()` does the work:
    // the block is simply not part of this schema.
    const result = producerEnvelopeSchema.safeParse({
      ...producerFixture,
      profile: {
        profile_id: "019ffe00-0000-7000-8000-000000000001",
        canonical_customer_id: "cus_impersonated",
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
    }
  });

  it("rejects a producer-supplied enrichment block", () => {
    const result = producerEnvelopeSchema.safeParse({
      ...producerFixture,
      enrichment: { geo: { country: "ZZ", region: null, city: null, source: "forged" } },
    });
    expect(result.success).toBe(false);
  });
});
