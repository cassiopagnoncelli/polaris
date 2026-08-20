import { describe, expect, it } from "vitest";

import {
  AWS_ACCESS_KEY_PATTERN,
  GITHUB_TOKEN_PATTERN,
  HIGH_ENTROPY_SECRET_PATTERN,
  JWT_PATTERN,
  LUHN_PAN_PATTERN,
} from "../src/index.js";
import { syntheticLuhn } from "./fixtures.js";

describe("Luhn PAN pattern detector", () => {
  it("matches a synthetic Luhn-valid 16-digit value in a non-card_number field", () => {
    const pan = syntheticLuhn(16);
    expect(LUHN_PAN_PATTERN.test(pan, ["properties", "notes"])).toBe(true);
  });

  it("matches PANs containing spaces or dashes", () => {
    const pan = syntheticLuhn(16);
    const spaced = `${pan.slice(0, 4)} ${pan.slice(4, 8)} ${pan.slice(8, 12)} ${pan.slice(12)}`;
    const dashed = `${pan.slice(0, 4)}-${pan.slice(4, 8)}-${pan.slice(8, 12)}-${pan.slice(12)}`;
    expect(LUHN_PAN_PATTERN.test(spaced, ["properties", "notes"])).toBe(true);
    expect(LUHN_PAN_PATTERN.test(dashed, ["properties", "notes"])).toBe(true);
  });

  it("skips card_number paths (the named-redact rule handles that)", () => {
    const pan = syntheticLuhn(16);
    expect(LUHN_PAN_PATTERN.test(pan, ["properties", "card_number"])).toBe(false);
    expect(LUHN_PAN_PATTERN.test(pan, ["properties", "cardNumber"])).toBe(false);
  });

  it("does not match non-Luhn 16-digit strings", () => {
    expect(LUHN_PAN_PATTERN.test("1234567890123456", ["properties", "notes"])).toBe(false);
  });

  it("does not match shorter/longer digit strings", () => {
    expect(LUHN_PAN_PATTERN.test(syntheticLuhn(13), ["properties", "x"])).toBe(true);
    expect(LUHN_PAN_PATTERN.test("1234567890", ["properties", "x"])).toBe(false);
    expect(LUHN_PAN_PATTERN.test("1".repeat(20), ["properties", "x"])).toBe(false);
  });
});

describe("AWS access key pattern detector", () => {
  it("matches AKIA prefix + base32 body", () => {
    // 4 prefix + 16 base32 chars
    expect(AWS_ACCESS_KEY_PATTERN.test("AKIAABCDEFGHIJKLMNOP", ["properties", "config"])).toBe(
      true,
    );
  });

  it("matches ASIA (STS) prefix", () => {
    expect(AWS_ACCESS_KEY_PATTERN.test("ASIAABCDEFGHIJKLMNOP", ["properties", "config"])).toBe(
      true,
    );
  });

  it("ignores lowercase prefix typos", () => {
    expect(AWS_ACCESS_KEY_PATTERN.test("akiaABCDEFGHIJKLMNOP", ["properties", "config"])).toBe(
      false,
    );
  });

  it("ignores wrong-length bodies", () => {
    expect(AWS_ACCESS_KEY_PATTERN.test("AKIAABC", ["properties", "config"])).toBe(false);
  });
});

describe("GitHub token pattern detector", () => {
  it("matches each documented prefix", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      const token = `${prefix}_${"a".repeat(36)}`;
      expect(GITHUB_TOKEN_PATTERN.test(token, ["properties", "config"])).toBe(true);
    }
  });

  it("ignores prefixes outside the documented set", () => {
    expect(GITHUB_TOKEN_PATTERN.test(`ghX_${"a".repeat(36)}`, ["properties", "x"])).toBe(false);
  });

  it("requires at least 36 trailing characters", () => {
    expect(GITHUB_TOKEN_PATTERN.test("ghp_short", ["properties", "x"])).toBe(false);
  });
});

describe("JWT pattern detector", () => {
  it("matches a three-segment base64url JWT outside identity.*", () => {
    const jwt = `${"a".repeat(20)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    expect(JWT_PATTERN.test(jwt, ["properties", "auth"])).toBe(true);
  });

  it("does not match inside identity.*", () => {
    const jwt = `${"a".repeat(20)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    expect(JWT_PATTERN.test(jwt, ["identity", "id_token"])).toBe(false);
  });

  it("does not match short dot-separated strings", () => {
    expect(JWT_PATTERN.test("a.b.c", ["properties", "auth"])).toBe(false);
  });
});

describe("Generic high-entropy secret pattern detector", () => {
  it("matches a 64+ character hex run", () => {
    const hex = "a1b2c3d4e5f607182930415263748596a7b8c9d0e1f203142536475869708192";
    expect(HIGH_ENTROPY_SECRET_PATTERN.test(hex, ["properties", "config"])).toBe(true);
  });

  it("matches a 43+ character high-entropy base64-ish run", () => {
    // ~50-char base64-ish string with mixed alpha/num.
    const base64 = "ZmFrZS1zZWNyZXQtZm9yLXRlc3QtMTIzNDU2Nzg5MGFiY2RlZi8r";
    expect(HIGH_ENTROPY_SECRET_PATTERN.test(base64, ["properties", "config"])).toBe(true);
  });

  it("ignores expected high-entropy ID fields", () => {
    const id = "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551018f1b9e7b507b129a2e0e2f88d8f551";
    expect(HIGH_ENTROPY_SECRET_PATTERN.test(id, ["event_id"])).toBe(false);
    expect(HIGH_ENTROPY_SECRET_PATTERN.test(id, ["identity", "anonymous_id"])).toBe(false);
  });

  it("ignores low-entropy long strings", () => {
    expect(HIGH_ENTROPY_SECRET_PATTERN.test("a".repeat(80), ["properties", "x"])).toBe(false);
    expect(HIGH_ENTROPY_SECRET_PATTERN.test("ababab".repeat(20), ["properties", "x"])).toBe(false);
  });

  it("ignores short strings under the length threshold", () => {
    expect(HIGH_ENTROPY_SECRET_PATTERN.test("short-id", ["properties", "x"])).toBe(false);
  });
});
