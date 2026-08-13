import type { SecretProviderConfig } from "@polaris/shared-config";
import { describe, expect, it } from "vitest";
import {
  createSecretResolver,
  InsecureSecretProviderError,
  SECRET_PROVIDER_STRICT_ENV_VAR,
} from "../src/factory.js";

function fakeLogger() {
  const warns: { fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    warn: (fields: Record<string, unknown>, message: string) => warns.push({ fields, message }),
    info: () => {},
    debug: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

const ENV_CONFIG: SecretProviderConfig = { provider: "env" };
const VAULT_CONFIG: SecretProviderConfig = {
  provider: "vault",
  vault: {
    address: "https://vault.internal:8200",
    role: "polaris-consumer",
    kvMount: "secret",
    kubernetesAuthMount: "kubernetes",
    tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    cacheTtlMs: 300_000,
  },
};

describe("createSecretResolver — env provider", () => {
  it("resolves from the supplied snapshot, not process.env", async () => {
    const { logger } = fakeLogger();
    const resolver = createSecretResolver({
      config: ENV_CONFIG,
      env: { MY_TOKEN: "from-the-snapshot" },
      logger: logger as never,
      deploymentEnvironment: "local",
    });
    await expect(resolver.resolve("env:MY_TOKEN")).resolves.toBe("from-the-snapshot");
  });

  it("is silent outside production", () => {
    const { logger, warns } = fakeLogger();
    createSecretResolver({
      config: ENV_CONFIG,
      env: {},
      logger: logger as never,
      deploymentEnvironment: "staging",
    });
    expect(warns).toHaveLength(0);
  });

  it("warns but still builds in production", () => {
    // A hard failure here would turn "deploy the new image" into an outage
    // for anyone currently running production on env: secrets.
    const { logger, warns } = fakeLogger();
    const resolver = createSecretResolver({
      config: ENV_CONFIG,
      env: {},
      logger: logger as never,
      deploymentEnvironment: "production",
    });
    expect(resolver).toBeDefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields["remediation"]).toContain("POLARIS_SECRET_PROVIDER=vault");
  });

  it("refuses in production under strict mode", () => {
    const { logger } = fakeLogger();
    expect(() =>
      createSecretResolver({
        config: ENV_CONFIG,
        env: { [SECRET_PROVIDER_STRICT_ENV_VAR]: "true" },
        logger: logger as never,
        deploymentEnvironment: "production",
      }),
    ).toThrow(InsecureSecretProviderError);
  });

  it("reads strict mode from the snapshot, case-insensitively", () => {
    const { logger } = fakeLogger();
    expect(() =>
      createSecretResolver({
        config: ENV_CONFIG,
        env: { [SECRET_PROVIDER_STRICT_ENV_VAR]: "TRUE" },
        logger: logger as never,
        deploymentEnvironment: "production",
      }),
    ).toThrow(InsecureSecretProviderError);
  });

  it("strict mode does not affect non-production", () => {
    const { logger } = fakeLogger();
    expect(() =>
      createSecretResolver({
        config: ENV_CONFIG,
        env: { [SECRET_PROVIDER_STRICT_ENV_VAR]: "true" },
        logger: logger as never,
        deploymentEnvironment: "development",
      }),
    ).not.toThrow();
  });
});

describe("createSecretResolver — vault provider", () => {
  it("builds a resolver that routes vault refs to the vault adapter", () => {
    const { logger, warns } = fakeLogger();
    const resolver = createSecretResolver({
      config: VAULT_CONFIG,
      env: {},
      logger: logger as never,
      deploymentEnvironment: "production",
    });
    expect(resolver).toBeDefined();
    // No warning: this is the configuration production is supposed to have.
    expect(warns).toHaveLength(0);
  });

  it("does not register the env adapter, so env refs fail as not-configured", async () => {
    const { logger } = fakeLogger();
    const resolver = createSecretResolver({
      config: VAULT_CONFIG,
      env: { LEAKED: "value" },
      logger: logger as never,
      deploymentEnvironment: "production",
    });
    await expect(resolver.resolve("env:LEAKED")).rejects.toThrow(/not configured/);
  });
});

describe("createSecretResolver — reserved provider slots", () => {
  it("builds an empty resolver and warns rather than throwing at startup", async () => {
    // The failure belongs at the reference that needs it, where the error
    // names both provider and ref — and classifies permanent, which is right
    // for a misconfiguration.
    const { logger, warns } = fakeLogger();
    const resolver = createSecretResolver({
      config: { provider: "aws-secrets-manager" } as SecretProviderConfig,
      env: {},
      logger: logger as never,
      deploymentEnvironment: "production",
    });
    expect(warns).toHaveLength(1);
    await expect(resolver.resolve("aws-secrets-manager:some/ref")).rejects.toThrow(
      /not configured/,
    );
  });
});
