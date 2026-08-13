import { describe, expect, it } from "vitest";
import { classifySecretFailure } from "../src/classify.js";
import {
  SecretNotFoundError,
  SecretProviderError,
  SecretProviderNotConfiguredError,
  SecretReferenceParseError,
} from "../src/errors.js";

describe("classifySecretFailure", () => {
  it("treats an unreachable or unauthenticated provider as transient", () => {
    // The reference may be perfectly good — Vault was simply not answering.
    // This is the case that used to permanently dead-letter deliveries.
    expect(classifySecretFailure(new SecretProviderError("vault", "polaris/x", "503"))).toBe(
      "transient",
    );
  });

  it("treats an unprovisioned reference as permanent", () => {
    expect(classifySecretFailure(new SecretNotFoundError("vault", "polaris/x"))).toBe("permanent");
  });

  it("treats an unwired provider slot as permanent", () => {
    expect(classifySecretFailure(new SecretProviderNotConfiguredError("vault", "polaris/x"))).toBe(
      "permanent",
    );
  });

  it("treats a malformed reference as permanent", () => {
    expect(classifySecretFailure(new SecretReferenceParseError("bad ref"))).toBe("permanent");
  });

  it("defaults unknown failures to transient", () => {
    // Deliberate asymmetry: a wrong `permanent` is immediate data loss needing
    // a manual replay, while a wrong `transient` costs bounded retries and
    // still reaches the DLQ at the dead-letter threshold.
    for (const err of [
      new Error("kaboom"),
      new TypeError("undefined is not a function"),
      "a string",
      undefined,
      null,
      { name: "NotAnError" },
    ]) {
      expect(classifySecretFailure(err), String(err)).toBe("transient");
    }
  });
});
