import { describe, expect, it } from "vitest";

import { canonicalizeExternalId, hashExternalId, sha256Hex } from "../src/index.js";

describe("canonicalizeExternalId", () => {
  it("trims surrounding whitespace", () => {
    expect(canonicalizeExternalId("  cus_001 ")).toBe("cus_001");
  });

  it("preserves case (Cust_001 differs from cust_001)", () => {
    expect(canonicalizeExternalId("Cust_001")).toBe("Cust_001");
  });

  it("rejects empty / whitespace-only IDs", () => {
    expect(() => canonicalizeExternalId("")).toThrow();
    expect(() => canonicalizeExternalId("   ")).toThrow();
  });
});

describe("hashExternalId", () => {
  it("hashes the trimmed form (no case folding)", () => {
    expect(hashExternalId("  Cust_001 ")).toBe(sha256Hex("Cust_001"));
  });

  it("is deterministic across invocations", () => {
    expect(hashExternalId("cus_001")).toBe(hashExternalId("cus_001"));
  });

  it("yields different hashes for case-distinct IDs", () => {
    expect(hashExternalId("Cust_001")).not.toBe(hashExternalId("cust_001"));
  });
});
