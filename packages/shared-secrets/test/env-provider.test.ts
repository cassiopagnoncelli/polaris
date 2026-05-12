import { describe, expect, it } from "vitest";

import { EnvSecretProvider, SecretNotFoundError, SecretProviderError } from "../src/index.js";

/**
 * Sentinel string used as the resolved secret value across the env-provider
 * tests. If it ever appears in an error message or a thrown error's
 * `.toString()`, the redaction contract is broken.
 */
const SECRET_VALUE = "tk_super_secret_value_should_not_leak";

describe("EnvSecretProvider", () => {
  it("returns the value when the env variable is set", async () => {
    const provider = new EnvSecretProvider({
      source: { META_CAPI_TOKEN: SECRET_VALUE },
    });
    await expect(provider.getSecret("META_CAPI_TOKEN")).resolves.toBe(SECRET_VALUE);
  });

  it("preserves whitespace inside the resolved value", async () => {
    // Tokens occasionally include base64 padding, dots, dashes, etc. The
    // provider must not strip or mangle them.
    const messy = "abc.def-ghi==";
    const provider = new EnvSecretProvider({ source: { TRICKY_TOKEN: messy } });
    await expect(provider.getSecret("TRICKY_TOKEN")).resolves.toBe(messy);
  });

  it("throws SecretNotFoundError when the env variable is unset", async () => {
    const provider = new EnvSecretProvider({ source: {} });
    await expect(provider.getSecret("MISSING_TOKEN")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("treats an empty env variable as missing", async () => {
    const provider = new EnvSecretProvider({ source: { EMPTY_TOKEN: "" } });
    await expect(provider.getSecret("EMPTY_TOKEN")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("attaches provider and ref metadata to the not-found error", async () => {
    const provider = new EnvSecretProvider({ source: {} });
    let caught: SecretNotFoundError | undefined;
    try {
      await provider.getSecret("MISSING_TOKEN");
    } catch (err) {
      if (err instanceof SecretNotFoundError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.provider).toBe("env");
    expect(caught?.ref).toBe("MISSING_TOKEN");
  });

  it("rejects refs that do not look like POSIX env var names", async () => {
    const provider = new EnvSecretProvider({
      source: { "lowercase-token": SECRET_VALUE },
    });
    await expect(provider.getSecret("lowercase-token")).rejects.toBeInstanceOf(SecretProviderError);
  });

  it("rejects refs starting with a digit", async () => {
    const provider = new EnvSecretProvider({ source: { "1TOKEN": SECRET_VALUE } });
    await expect(provider.getSecret("1TOKEN")).rejects.toBeInstanceOf(SecretProviderError);
  });

  it("rejects empty refs without hitting the env source", async () => {
    let consulted = false;
    const provider = new EnvSecretProvider({
      source: new Proxy(
        {},
        {
          get() {
            consulted = true;
            return SECRET_VALUE;
          },
        },
      ) as Readonly<Record<string, string | undefined>>,
    });
    await expect(provider.getSecret("")).rejects.toBeInstanceOf(SecretProviderError);
    expect(consulted).toBe(false);
  });

  it("does not include the resolved secret in not-found error output", async () => {
    // The reference does not resolve so the secret is not even available — but
    // we still want to assert that nothing about the *message* could leak a
    // resolved value if the implementation accidentally read the env source.
    const provider = new EnvSecretProvider({
      source: { LEAKY_TOKEN: SECRET_VALUE },
    });
    let caught: Error | undefined;
    try {
      await provider.getSecret("MISSING_TOKEN");
    } catch (err) {
      if (err instanceof Error) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.message ?? "").not.toContain(SECRET_VALUE);
    expect(String(caught) ?? "").not.toContain(SECRET_VALUE);
    expect(caught?.stack ?? "").not.toContain(SECRET_VALUE);
  });

  it("does not include the resolved secret in invalid-ref error output", async () => {
    const provider = new EnvSecretProvider({
      source: { LEAKY_TOKEN: SECRET_VALUE },
    });
    let caught: Error | undefined;
    try {
      await provider.getSecret("not-a-valid-env-name");
    } catch (err) {
      if (err instanceof Error) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.message ?? "").not.toContain(SECRET_VALUE);
  });

  it("exposes the env provider identifier", () => {
    const provider = new EnvSecretProvider({ source: {} });
    expect(provider.provider).toBe("env");
  });
});
