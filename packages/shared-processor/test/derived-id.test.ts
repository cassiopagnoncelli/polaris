/**
 * Tests for deterministic derived event ids.
 *
 * The properties that make replay a repair rather than a duplication:
 * stability across calls and processes, separation by processor and slot, and
 * — the one everybody gets wrong — independence from the processor version.
 */
import { describe, expect, it } from "vitest";

import { deriveEventId, POLARIS_DERIVED_EVENT_NAMESPACE } from "../src/derived-id.js";

const SOURCE = "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551";

describe("deriveEventId", () => {
  it("returns the same id for the same cause", () => {
    const a = deriveEventId({ processor: "sessionizer", sourceEventId: SOURCE, slot: "started" });
    const b = deriveEventId({ processor: "sessionizer", sourceEventId: SOURCE, slot: "started" });
    expect(a).toBe(b);
  });

  it("produces a syntactically valid UUID, so the envelope schema is unchanged", () => {
    const id = deriveEventId({
      processor: "geoip-enricher",
      sourceEventId: SOURCE,
      slot: "enriched",
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("separates processors, so two processors reading one event do not collide", () => {
    expect(deriveEventId({ processor: "sessionizer", sourceEventId: SOURCE, slot: "s" })).not.toBe(
      deriveEventId({ processor: "geoip-enricher", sourceEventId: SOURCE, slot: "s" }),
    );
  });

  it("separates slots, so one source event can yield several derived events", () => {
    expect(
      deriveEventId({
        processor: "attribution-engine",
        sourceEventId: SOURCE,
        slot: "first_touch",
      }),
    ).not.toBe(
      deriveEventId({ processor: "attribution-engine", sourceEventId: SOURCE, slot: "last_touch" }),
    );
  });

  it("separates source events", () => {
    expect(deriveEventId({ processor: "p", sourceEventId: SOURCE, slot: "s" })).not.toBe(
      deriveEventId({
        processor: "p",
        sourceEventId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
        slot: "s",
      }),
    );
  });

  it("is INDEPENDENT of processor version — the property that makes replay a repair", () => {
    // Not expressible as an argument, which is the point: there is no version
    // parameter to pass. If one is ever added, this test is the place that
    // explains why it must not be. Shipping a fix bumps the version; if the
    // version were in the key, the replay of that fix would mint ids that
    // collide with nothing and replace nothing, leaving the wrong rows beside
    // the right ones forever.
    const beforeFix = deriveEventId({
      processor: "sessionizer",
      sourceEventId: SOURCE,
      slot: "started",
    });
    const afterFix = deriveEventId({
      processor: "sessionizer",
      sourceEventId: SOURCE,
      slot: "started",
    });
    expect(afterFix).toBe(beforeFix);
  });

  it("pins the namespace, because changing it re-mints every derived id ever stored", () => {
    expect(POLARIS_DERIVED_EVENT_NAMESPACE).toBe("6f2a1c84-9c1e-4f7b-8a30-1d5c6b0e9f42");
  });

  it("pins the key material, so a refactor cannot silently re-mint ids", () => {
    // A frozen expectation rather than a recomputation: if the separator, the
    // field order, or the namespace changes, every derived id in ClickHouse
    // stops matching its own replay and this fails loudly.
    expect(
      deriveEventId({ processor: "sessionizer", sourceEventId: SOURCE, slot: "started" }),
    ).toBe("778cf67b-8352-5a95-a302-015594d57004");
  });
});
