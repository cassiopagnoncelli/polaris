import { describe, expect, it } from "vitest";

import {
  formatSecretReference,
  isSecretProvider,
  parseSecretReference,
  SECRET_PROVIDERS,
  SecretReferenceParseError,
} from "../src/index.js";

describe("isSecretProvider", () => {
  it("accepts every reserved provider slot", () => {
    for (const provider of SECRET_PROVIDERS) {
      expect(isSecretProvider(provider)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isSecretProvider("file")).toBe(false);
    expect(isSecretProvider("ENV")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isSecretProvider(undefined)).toBe(false);
    expect(isSecretProvider(null)).toBe(false);
    expect(isSecretProvider(123)).toBe(false);
    expect(isSecretProvider({ provider: "env" })).toBe(false);
  });
});

describe("parseSecretReference", () => {
  it("parses object form", () => {
    const reference = parseSecretReference({ provider: "env", ref: "META_CAPI_TOKEN" });
    expect(reference.provider).toBe("env");
    expect(reference.ref).toBe("META_CAPI_TOKEN");
    expect(Object.isFrozen(reference)).toBe(true);
  });

  it("parses string form", () => {
    const reference = parseSecretReference("env:META_CAPI_TOKEN");
    expect(reference).toEqual({ provider: "env", ref: "META_CAPI_TOKEN" });
  });

  it("preserves colons inside the ref portion", () => {
    const reference = parseSecretReference("vault:polaris/production/storefront/meta-capi");
    expect(reference.provider).toBe("vault");
    expect(reference.ref).toBe("polaris/production/storefront/meta-capi");
  });

  it("preserves colons inside Vault-style refs with embedded path segments", () => {
    const reference = parseSecretReference("vault:kv/data/polaris:abcd");
    expect(reference.provider).toBe("vault");
    expect(reference.ref).toBe("kv/data/polaris:abcd");
  });

  it("rejects unknown providers in string form", () => {
    expect(() => parseSecretReference("file:/etc/passwd")).toThrow(SecretReferenceParseError);
  });

  it("rejects unknown providers in object form", () => {
    expect(() => parseSecretReference({ provider: "file", ref: "x" } as never)).toThrow(
      SecretReferenceParseError,
    );
  });

  it("rejects missing colon in string form", () => {
    expect(() => parseSecretReference("env")).toThrow(SecretReferenceParseError);
  });

  it("rejects empty provider in string form", () => {
    expect(() => parseSecretReference(":META_CAPI_TOKEN")).toThrow(SecretReferenceParseError);
  });

  it("rejects empty ref in string form", () => {
    expect(() => parseSecretReference("env:")).toThrow(SecretReferenceParseError);
  });

  it("rejects empty ref in object form", () => {
    expect(() => parseSecretReference({ provider: "env", ref: "" })).toThrow(
      SecretReferenceParseError,
    );
  });

  it("rejects refs with whitespace", () => {
    expect(() => parseSecretReference("env:HAS SPACE")).toThrow(SecretReferenceParseError);
    expect(() => parseSecretReference({ provider: "env", ref: "HAS\nLINE" })).toThrow(
      SecretReferenceParseError,
    );
  });

  it("rejects refs exceeding the maximum length", () => {
    const giant = "A".repeat(2048);
    expect(() => parseSecretReference({ provider: "env", ref: giant })).toThrow(
      SecretReferenceParseError,
    );
  });

  it("rejects non-string ref values in object form", () => {
    expect(() => parseSecretReference({ provider: "env", ref: 123 as never })).toThrow(
      SecretReferenceParseError,
    );
  });

  it("rejects null input", () => {
    expect(() => parseSecretReference(null as never)).toThrow(SecretReferenceParseError);
  });

  it("rejects empty string", () => {
    expect(() => parseSecretReference("")).toThrow(SecretReferenceParseError);
  });

  it("does not include the offending input in the error message", () => {
    // The ref may itself be a secret value if a caller misuses the API; the
    // error must describe the failure shape without echoing input back.
    const secretLooking = "AKIA0000000000000000:thisShouldNotLeak";
    let caught: SecretReferenceParseError | undefined;
    try {
      parseSecretReference(secretLooking);
    } catch (err) {
      if (err instanceof SecretReferenceParseError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.message ?? "").not.toContain("thisShouldNotLeak");
  });
});

describe("formatSecretReference", () => {
  it("round-trips through parse", () => {
    const original = parseSecretReference({ provider: "env", ref: "META_CAPI_TOKEN" });
    const formatted = formatSecretReference(original);
    expect(formatted).toBe("env:META_CAPI_TOKEN");
    expect(parseSecretReference(formatted)).toEqual(original);
  });

  it("preserves embedded colons in refs through round-trip", () => {
    const formatted = formatSecretReference({
      provider: "vault",
      ref: "polaris/production/storefront/meta-capi",
    });
    expect(formatted).toBe("vault:polaris/production/storefront/meta-capi");
    expect(parseSecretReference(formatted).ref).toBe("polaris/production/storefront/meta-capi");
  });
});
