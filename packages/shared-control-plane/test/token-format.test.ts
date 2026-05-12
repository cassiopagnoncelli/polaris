import { describe, expect, it } from "vitest";

import { formatOperatorToken, OPERATOR_TOKEN_ID_PREFIX, parseOperatorToken } from "../src/index.js";

describe("operator token prefix", () => {
  it("uses the polaris_ot_ namespace (distinct from polaris_ak_)", () => {
    expect(OPERATOR_TOKEN_ID_PREFIX).toBe("polaris_ot_");
  });
});

describe("formatOperatorToken", () => {
  it("joins id and secret with a single dot", () => {
    expect(formatOperatorToken("polaris_ot_abc", "secret-tail")).toBe("polaris_ot_abc.secret-tail");
  });
});

describe("parseOperatorToken", () => {
  it("returns null for undefined / non-string input", () => {
    expect(parseOperatorToken(undefined)).toBeNull();
    expect(parseOperatorToken(null)).toBeNull();
    expect(parseOperatorToken(42)).toBeNull();
  });

  it("returns null for empty / whitespace input", () => {
    expect(parseOperatorToken("")).toBeNull();
    expect(parseOperatorToken("   ")).toBeNull();
  });

  it("returns null when the prefix is wrong (e.g. api-key shape)", () => {
    expect(parseOperatorToken("polaris_ak_x.secret")).toBeNull();
    expect(parseOperatorToken("not-a-polaris-token")).toBeNull();
  });

  it("returns null when the separator is missing", () => {
    expect(parseOperatorToken("polaris_ot_only-id")).toBeNull();
  });

  it("returns null when either part is empty", () => {
    expect(parseOperatorToken("polaris_ot_.tail")).toBeNull();
    expect(parseOperatorToken("polaris_ot_id.")).toBeNull();
  });

  it("parses a well-formed token", () => {
    const parsed = parseOperatorToken("polaris_ot_018f.raw-secret-tail");
    expect(parsed).toEqual({
      operatorTokenId: "polaris_ot_018f",
      rawSecret: "raw-secret-tail",
    });
  });

  it("preserves dots in the secret tail (only the first separator matters)", () => {
    const parsed = parseOperatorToken("polaris_ot_abc.has.dots.in.secret");
    expect(parsed).toEqual({
      operatorTokenId: "polaris_ot_abc",
      rawSecret: "has.dots.in.secret",
    });
  });

  it("trims surrounding whitespace before parsing", () => {
    const parsed = parseOperatorToken("   polaris_ot_abc.secret  ");
    expect(parsed).toEqual({
      operatorTokenId: "polaris_ot_abc",
      rawSecret: "secret",
    });
  });
});
