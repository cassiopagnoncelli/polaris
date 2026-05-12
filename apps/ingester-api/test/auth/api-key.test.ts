import { describe, expect, it } from "vitest";

import { API_KEY_HEADER, parseApiKeyHeader } from "../../src/auth/api-key.js";

describe("API_KEY_HEADER", () => {
  it("uses the documented lowercase header name", () => {
    expect(API_KEY_HEADER).toBe("x-polaris-api-key");
  });
});

describe("parseApiKeyHeader", () => {
  it("parses a well-formed header", () => {
    const parsed = parseApiKeyHeader("ak_abc.secrettail");
    expect(parsed).toEqual({ apiKeyId: "ak_abc", secret: "secrettail" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseApiKeyHeader("  ak_abc.secret  ")).toEqual({
      apiKeyId: "ak_abc",
      secret: "secret",
    });
  });

  it("treats embedded dots after the first as part of the secret tail", () => {
    // The separator is the first `.`; secrets may legitimately contain dots
    // (e.g. base64url segments).
    expect(parseApiKeyHeader("ak_abc.seg1.seg2.seg3")).toEqual({
      apiKeyId: "ak_abc",
      secret: "seg1.seg2.seg3",
    });
  });

  it("returns null for an undefined input", () => {
    expect(parseApiKeyHeader(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseApiKeyHeader("")).toBeNull();
    expect(parseApiKeyHeader("   ")).toBeNull();
  });

  it("returns null when no separator is present", () => {
    expect(parseApiKeyHeader("ak_abc")).toBeNull();
    expect(parseApiKeyHeader("only-secret")).toBeNull();
  });

  it("returns null when the prefix or secret is empty", () => {
    expect(parseApiKeyHeader(".secret")).toBeNull();
    expect(parseApiKeyHeader("ak_abc.")).toBeNull();
  });
});
