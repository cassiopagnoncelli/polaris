import { describe, expect, it } from "vitest";

import { CONSENT_DIMENSIONS, evaluateConsent } from "../src/index.js";

describe("evaluateConsent", () => {
  it("returns granted when no required dimension is declared", () => {
    const result = evaluateConsent({ marketing: false }, {});
    expect(result.status).toBe("granted");
  });

  it("returns granted when all required dimensions are explicitly true", () => {
    const result = evaluateConsent(
      { analytics: true, marketing: true, personalization: true },
      { marketing: true },
    );
    expect(result.status).toBe("granted");
    if (result.status !== "granted") return;
    expect(result.dimensions).toHaveLength(1);
    expect(result.dimensions[0]).toEqual({
      dimension: "marketing",
      required: true,
      granted: true,
    });
  });

  it("absent-as-true: a missing consent field is treated as granted", () => {
    const result = evaluateConsent(undefined, { marketing: true });
    expect(result.status).toBe("granted");
  });

  it("absent-as-true: null consent is treated as granted", () => {
    const result = evaluateConsent(null, { marketing: true });
    expect(result.status).toBe("granted");
  });

  it("absent-as-true: a null dimension value is treated as granted", () => {
    const result = evaluateConsent({ marketing: null }, { marketing: true });
    expect(result.status).toBe("granted");
  });

  it("denies when a required dimension is explicitly false", () => {
    const result = evaluateConsent({ marketing: false, analytics: true }, { marketing: true });
    expect(result.status).toBe("denied");
    if (result.status !== "denied") return;
    expect(result.deniedBy).toBe("marketing");
  });

  it("ignores dimensions that the destination did not declare required", () => {
    const result = evaluateConsent({ marketing: false }, { analytics: true });
    expect(result.status).toBe("granted");
  });

  it("denial order is stable (analytics > marketing > personalization)", () => {
    const result = evaluateConsent(
      { analytics: false, marketing: false, personalization: false },
      { analytics: true, marketing: true, personalization: true },
    );
    expect(result.status).toBe("denied");
    if (result.status !== "denied") return;
    expect(result.deniedBy).toBe("analytics");
  });

  it("exposes the canonical consent dimensions in stable order", () => {
    expect(CONSENT_DIMENSIONS).toEqual(["analytics", "marketing", "personalization"]);
  });
});

describe("evaluateConsent — observed", () => {
  it("reports every dimension, not only the ones the destination gates on", () => {
    // The gate is one question and the vendor's consent-mode block is
    // another: GA4 declares `analytics` and forwards `marketing` /
    // `personalization` to Google on events it delivers.
    const result = evaluateConsent(
      { analytics: true, marketing: false, personalization: true },
      { analytics: true },
    );
    expect(result.status).toBe("granted");
    expect(result.dimensions).toHaveLength(1);
    expect(result.observed).toEqual({
      analytics: true,
      marketing: false,
      personalization: true,
    });
  });

  it("applies absent-as-true, so an absent block reads as fully granted", () => {
    expect(evaluateConsent(undefined, {}).observed).toEqual({
      analytics: true,
      marketing: true,
      personalization: true,
    });
    expect(evaluateConsent({ marketing: null }, {}).observed?.marketing).toBe(true);
  });

  it("is present on a denied evaluation too", () => {
    const result = evaluateConsent({ analytics: false, marketing: false }, { analytics: true });
    expect(result.status).toBe("denied");
    expect(result.observed).toEqual({
      analytics: false,
      marketing: false,
      personalization: true,
    });
  });

  it("agrees with the gate on every dimension the gate did evaluate", () => {
    const result = evaluateConsent(
      { analytics: true, marketing: false, personalization: false },
      { analytics: true, marketing: true },
    );
    for (const dimension of result.dimensions) {
      expect(result.observed?.[dimension.dimension]).toBe(dimension.granted);
    }
  });
});
