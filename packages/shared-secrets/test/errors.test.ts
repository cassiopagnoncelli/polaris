import { describe, expect, it } from "vitest";

import {
  SecretError,
  SecretNotFoundError,
  SecretProviderError,
  SecretProviderNotConfiguredError,
  SecretReferenceParseError,
} from "../src/index.js";

const SECRET_VALUE = "tk_error_secret_should_not_leak";

describe("SecretError hierarchy", () => {
  it("SecretNotFoundError is a SecretError and an Error", () => {
    const err = new SecretNotFoundError("env", "META_CAPI_TOKEN");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SecretError);
    expect(err.name).toBe("SecretNotFoundError");
    expect(err.provider).toBe("env");
    expect(err.ref).toBe("META_CAPI_TOKEN");
  });

  it("SecretProviderError preserves the cause chain", () => {
    const cause = new Error("network unreachable");
    const err = new SecretProviderError("env", "META_CAPI_TOKEN", "lookup failed", {
      cause,
    });
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("SecretProviderError");
    expect(err.message).toContain("env");
    expect(err.message).toContain("META_CAPI_TOKEN");
    expect(err.message).toContain("lookup failed");
  });

  it("SecretProviderNotConfiguredError advertises the missing slot", () => {
    const err = new SecretProviderNotConfiguredError("vault", "polaris/x");
    expect(err.name).toBe("SecretProviderNotConfiguredError");
    expect(err.provider).toBe("vault");
    expect(err.ref).toBe("polaris/x");
    expect(err.message).toContain("vault");
  });

  it("SecretReferenceParseError carries the reason without echoing input", () => {
    const err = new SecretReferenceParseError('unknown provider "file"');
    expect(err.name).toBe("SecretReferenceParseError");
    expect(err.reason).toBe('unknown provider "file"');
    expect(err.message).toContain("unknown provider");
  });

  it("no error type includes a resolved secret value in its message", () => {
    const errors: Error[] = [
      new SecretNotFoundError("env", "META_CAPI_TOKEN"),
      new SecretProviderError("env", "META_CAPI_TOKEN", "lookup failed", {
        cause: new Error(SECRET_VALUE), // even a leaky cause must not bleed into the message
      }),
      new SecretProviderNotConfiguredError("vault", "polaris/x"),
      new SecretReferenceParseError("malformed input"),
    ];
    for (const err of errors) {
      expect(err.message).not.toContain(SECRET_VALUE);
    }
  });
});
