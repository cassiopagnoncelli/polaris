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
