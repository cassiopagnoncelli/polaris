import { describe, expect, it } from "vitest";

import { canonicalizeEmail, hashEmailLower, sha256Hex } from "../src/index.js";

describe("canonicalizeEmail", () => {
  it("lowercases and trims surrounding whitespace", () => {
    expect(canonicalizeEmail("  ALICE@Example.COM ")).toBe("alice@example.com");
  });

  it("is idempotent (canonicalizing twice equals canonicalizing once)", () => {
    const once = canonicalizeEmail("Foo@Bar.com");
    expect(canonicalizeEmail(once)).toBe(once);
  });
});

describe("hashEmailLower", () => {
  it("hashes the canonical form, not the raw input", () => {
    // The hash of the canonical "alice@example.com" must match the hash
    // produced from a messy producer payload.
    const expected = sha256Hex("alice@example.com");
    expect(hashEmailLower("  ALICE@Example.COM ")).toBe(expected);
    expect(hashEmailLower("alice@example.com")).toBe(expected);
  });

  it("is deterministic across invocations", () => {
    const a = hashEmailLower("alice@example.com");
    const b = hashEmailLower("alice@example.com");
    expect(a).toBe(b);
  });

  it("rejects whitespace-only input (canonical form would be empty)", () => {
    expect(() => hashEmailLower("   ")).toThrow();
  });
});
