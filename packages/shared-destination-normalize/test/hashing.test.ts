import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/index.js";

describe("sha256Hex", () => {
  it("returns the canonical lowercase hex digest for a known input", () => {
    // NIST SHA-256 test vector: input "abc"
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic across invocations", () => {
    const first = sha256Hex("polaris");
    const second = sha256Hex("polaris");
    expect(first).toBe(second);
  });

  it("treats input as UTF-8", () => {
    // Cyrillic а (U+0430) vs Latin a (U+0061) must hash differently.
    expect(sha256Hex("а")).not.toBe(sha256Hex("a"));
  });

  it("rejects empty input to avoid identity collision", () => {
    expect(() => sha256Hex("")).toThrow(/empty input/);
  });
});
