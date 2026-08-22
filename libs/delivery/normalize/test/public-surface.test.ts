import { describe, expect, it } from "vitest";

import * as pkg from "../src/index.js";

/**
 * Per the task brief: the public surface must expose exactly the named
 * exports — no `default`, no accidental re-exports. This test makes the
 * public API explicit and forces any future addition through PR review.
 */
describe("public surface (`import * as pkg`)", () => {
  it("does not export a default", () => {
    expect((pkg as { default?: unknown }).default).toBeUndefined();
  });

  it("exports the expected runtime helpers", () => {
    const expectedRuntimeExports = [
      // normalize.ts
      "DROP_REASONS",
      "applySecondPassRedactions",
      "normalizeForDestination",
      // identity.ts
      "pickBestIdentity",
      "prepareIdentity",
      // person.ts
      "PERSON_MATCH_KEYS",
      "normalizePerson",
      // address.ts
      "ADDRESS_MATCH_KEYS",
      "normalizeAddress",
      // context.ts
      "flattenContext",
      "hasAppContext",
      // consent.ts
      "CONSENT_DIMENSIONS",
      "evaluateConsent",
      // hashing.ts
      "sha256Hex",
      // email.ts
      "canonicalizeEmail",
      "hashEmailLower",
      // phone.ts
      "hashPhoneE164",
      "requireE164",
      // external-id.ts
      "canonicalizeExternalId",
      "hashExternalId",
      // currency.ts
      "CURRENCY_EXPONENTS",
      "DEFAULT_CURRENCY_EXPONENT",
      "exponentForCurrency",
      "majorToMinor",
      "minorToMajor",
      // timestamp.ts
      "isoToEpochMicros",
      "isoToEpochMs",
      "isoToEpochSeconds",
    ];
    const actualRuntime = Object.keys(pkg)
      .filter((k) => typeof (pkg as Record<string, unknown>)[k] !== "undefined")
      .sort();
    const expectedSorted = [...expectedRuntimeExports].sort();
    expect(actualRuntime).toEqual(expectedSorted);
  });

  it("does not re-export governance or spec internals", () => {
    // Spot-check a handful of names that would indicate accidental
    // `export *` re-exports from upstream packages.
    const forbidden = [
      "evaluate",
      "applyRedactions",
      "PLATFORM_DEFAULT_POLICY",
      "envelopeSchema",
      "consentSchema",
      "identitySchema",
    ];
    for (const name of forbidden) {
      expect((pkg as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
