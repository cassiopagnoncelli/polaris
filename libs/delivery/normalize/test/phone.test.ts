import { describe, expect, it } from "vitest";

import { hashPhoneE164, requireE164, sha256Hex } from "../src/index.js";

describe("requireE164", () => {
  it("accepts a strict E.164 number", () => {
    expect(requireE164("+15555550123")).toBe("+15555550123");
    expect(requireE164("+447911123456")).toBe("+447911123456");
  });

  it("trims surrounding whitespace before validation", () => {
    expect(requireE164("  +15555550123 ")).toBe("+15555550123");
  });

  it("rejects unformatted US shape ((415) 555-0123)", () => {
    expect(() => requireE164("(415) 555-0123")).toThrow(/E\.164/);
  });

  it("rejects numbers without a leading plus", () => {
    expect(() => requireE164("15555550123")).toThrow(/E\.164/);
  });

  it("rejects numbers with internal punctuation", () => {
    expect(() => requireE164("+1-555-555-0123")).toThrow(/E\.164/);
  });

  it("rejects numbers with an extension", () => {
    expect(() => requireE164("+15555550123x123")).toThrow(/E\.164/);
  });

  it("rejects empty string", () => {
    expect(() => requireE164("")).toThrow(/E\.164/);
  });
});

describe("hashPhoneE164", () => {
  it("hashes the E.164 form as-is", () => {
    expect(hashPhoneE164("+15555550123")).toBe(sha256Hex("+15555550123"));
  });

  it("is deterministic across invocations", () => {
    expect(hashPhoneE164("+15555550123")).toBe(hashPhoneE164("+15555550123"));
  });

  it("rejects non-E.164 input rather than silently inserting a country code", () => {
    expect(() => hashPhoneE164("(415) 555-0123")).toThrow(/E\.164/);
    expect(() => hashPhoneE164("4155550123")).toThrow(/E\.164/);
  });
});
