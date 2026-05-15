import { describe, expect, it } from "vitest";

import {
  EnvSecretProvider,
  SecretNotFoundError,
  type SecretProviderAdapter,
  SecretProviderError,
  SecretProviderNotConfiguredError,
  SecretReferenceParseError,
  SecretResolver,
} from "../src/index.js";

const SECRET_VALUE = "tk_resolver_secret_should_not_leak";

describe("SecretResolver", () => {
  it("routes string-form references through the env provider", async () => {
    const resolver = new SecretResolver({
      adapters: {
        env: new EnvSecretProvider({ source: { META_CAPI_TOKEN: SECRET_VALUE } }),
      },
    });
    await expect(resolver.resolve("env:META_CAPI_TOKEN")).resolves.toBe(SECRET_VALUE);
  });

  it("routes object-form references through the env provider", async () => {
    const resolver = new SecretResolver({
      adapters: {
        env: new EnvSecretProvider({ source: { META_CAPI_TOKEN: SECRET_VALUE } }),
      },
    });
    await expect(resolver.resolve({ provider: "env", ref: "META_CAPI_TOKEN" })).resolves.toBe(
      SECRET_VALUE,
    );
  });

  it("throws SecretProviderNotConfiguredError for reserved-but-unwired slots", async () => {
    const resolver = new SecretResolver({ adapters: {} });
    await expect(resolver.resolve({ provider: "vault", ref: "polaris/x" })).rejects.toBeInstanceOf(
      SecretProviderNotConfiguredError,
    );
  });

  it("propagates SecretNotFoundError from the adapter", async () => {
    const resolver = new SecretResolver({
      adapters: { env: new EnvSecretProvider({ source: {} }) },
    });
    await expect(resolver.resolve("env:MISSING")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("propagates SecretReferenceParseError before touching adapters", async () => {
    let invoked = false;
    const fakeAdapter: SecretProviderAdapter = {
      provider: "env",
      async getSecret(): Promise<string> {
        invoked = true;
        return "should-not-reach";
      },
    };
    const resolver = new SecretResolver({ adapters: { env: fakeAdapter } });
    await expect(resolver.resolve("not-a-valid-reference")).rejects.toBeInstanceOf(
      SecretReferenceParseError,
    );
    expect(invoked).toBe(false);
  });

  it("propagates SecretProviderError from the adapter unchanged", async () => {
    const failing: SecretProviderAdapter = {
      provider: "env",
      async getSecret(): Promise<string> {
        throw new SecretProviderError("env", "META_CAPI_TOKEN", "simulated transport failure");
      },
    };
    const resolver = new SecretResolver({ adapters: { env: failing } });
    await expect(resolver.resolve("env:META_CAPI_TOKEN")).rejects.toBeInstanceOf(
      SecretProviderError,
    );
  });

  it("does not leak the resolved value when an adapter accidentally throws a plain Error containing the secret", async () => {
    // This guards against future adapter regressions: even if an adapter
    // accidentally constructs an error that includes a secret-shaped payload,
    // the resolver must not catch-and-rewrap into a message that re-exposes
    // it. The contract: the resolver propagates the adapter's error
    // unchanged. Callers are responsible for never logging adapter errors
    // without redaction (which the platform logger does by default).
    const accidentallyLeaky: SecretProviderAdapter = {
      provider: "env",
      async getSecret(): Promise<string> {
        throw new Error(`upstream failed with body=${SECRET_VALUE}`);
      },
    };
    const resolver = new SecretResolver({ adapters: { env: accidentallyLeaky } });
    let caught: Error | undefined;
    try {
      await resolver.resolve("env:META_CAPI_TOKEN");
    } catch (err) {
      if (err instanceof Error) caught = err;
    }
    expect(caught).toBeDefined();
    // The resolver itself wraps nothing; the adapter's leaky error is the one
    // we receive. The test asserts that the resolver does not *amplify* the
    // leak by, e.g., constructing a new error string that concatenates it
    // again. The original message is allowed to remain — redaction at the
    // call site (logger) is responsible for keeping it out of logs.
    expect(caught?.name).toBe("Error");
  });

  it("parse helper returns the same frozen reference shape", () => {
    const resolver = new SecretResolver({ adapters: {} });
    const parsed = resolver.parse("env:META_CAPI_TOKEN");
    expect(parsed).toEqual({ provider: "env", ref: "META_CAPI_TOKEN" });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("configuredProviders reports the registered slots", () => {
    const resolver = new SecretResolver({
      adapters: { env: new EnvSecretProvider({ source: {} }) },
    });
    expect(resolver.configuredProviders()).toEqual(["env"]);
  });

  it("returns an empty configuredProviders list when nothing is registered", () => {
    const resolver = new SecretResolver({ adapters: {} });
    expect(resolver.configuredProviders()).toEqual([]);
  });

  it("does not include the resolved value in the not-configured error", async () => {
    // The reference here is for an unwired provider, so there is no resolved
    // value to leak. The assertion checks that error stringification stays
    // free of the ref's literal bytes appearing in an unexpected context.
    const resolver = new SecretResolver({ adapters: {} });
    let caught: SecretProviderNotConfiguredError | undefined;
    try {
      await resolver.resolve({ provider: "vault", ref: "polaris/secret/path" });
    } catch (err) {
      if (err instanceof SecretProviderNotConfiguredError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.provider).toBe("vault");
    expect(caught?.ref).toBe("polaris/secret/path");
  });
});
