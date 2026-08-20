import { describe, expect, it } from "vitest";

import { PLATFORM_DEFAULT_POLICY } from "../src/index.js";

/**
 * The platform defaults are part of the architectural contract. Any
 * change here is a platform-wide policy change and requires explicit
 * review. The tests below pin the shape so a typo in `policy.ts` does
 * not silently broaden or narrow the platform list.
 */
describe("PLATFORM_DEFAULT_POLICY", () => {
  it("rejects exactly the named pii_card and pii_secret fields", () => {
    const fields = PLATFORM_DEFAULT_POLICY.reject.map((rule) => rule.field).sort();
    expect(fields).toEqual(
      [
        "authorization",
        "authorization_header",
        "card_number_full",
        "card_security_code",
        "cookie",
        "cvc",
        "cvv",
        "passwd",
        "password",
        "pem_private_key",
        "priv_key",
        "private_key",
        "pwd",
        "session_cookie",
      ].sort(),
    );
  });

  it("rejects only pii_card and pii_secret reasons (no other categories)", () => {
    const reasons = new Set(PLATFORM_DEFAULT_POLICY.reject.map((rule) => rule.reason));
    expect([...reasons].sort()).toEqual(["pii_card", "pii_secret"]);
  });

  it("redacts the named card_number field with pii_card reason", () => {
    expect(PLATFORM_DEFAULT_POLICY.redactNamed.map((rule) => rule.field)).toEqual(["card_number"]);
    expect(PLATFORM_DEFAULT_POLICY.redactNamed[0]?.reason).toBe("pii_card");
  });

  it("ships exactly five pattern-based detections", () => {
    expect(PLATFORM_DEFAULT_POLICY.redactPatterns.map((rule) => rule.pattern)).toEqual([
      "luhn_pan",
      "aws_access_key",
      "github_token",
      "jwt",
      "high_entropy_secret",
    ]);
  });

  it("never has a pattern entry on the reject list", () => {
    // Pattern rules carry a `pattern` tag; named-field rules do not.
    for (const rule of PLATFORM_DEFAULT_POLICY.reject) {
      expect(rule).not.toHaveProperty("pattern");
    }
  });

  it("does not include intentionally-excluded categories", () => {
    const fields = PLATFORM_DEFAULT_POLICY.reject
      .concat(PLATFORM_DEFAULT_POLICY.redactNamed)
      .map((rule) => rule.field.toLowerCase());
    // These are documented as intentionally NOT on platform defaults.
    for (const intentionallyExcluded of [
      "iban",
      "account_number",
      "email",
      "phone",
      "first_name",
      "last_name",
      "ip",
      "user_agent",
    ]) {
      expect(fields).not.toContain(intentionallyExcluded);
    }
  });

  it("is frozen so accidental mutation by callers fails fast", () => {
    expect(Object.isFrozen(PLATFORM_DEFAULT_POLICY)).toBe(true);
  });
});
