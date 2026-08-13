/**
 * Build a {@link SecretResolver} from parsed configuration.
 *
 * Before this existed, `createVaultProvider` had no callers anywhere in the
 * workspace and `secretProviderEnvSchema` was consumed by nothing: every
 * consumer hard-coded `new EnvSecretProvider({ source: process.env })`. So the
 * Vault adapter was fully written, fully tested, and unreachable — and five
 * services read `process.env` directly, which is the escape hatch the
 * project-config programme exists to close.
 *
 * One factory replaces all five, and takes a FROZEN env snapshot rather than
 * `process.env`, which is what the env adapter's own documentation asks for.
 *
 * @see docs/implementation/project-config-plan.md §6, §7
 * @see packages/shared-config/src/schemas/secret-provider.ts
 */

import type { EnvSource, SecretProviderConfig } from "@polaris/shared-config";
import type { Logger } from "@polaris/shared-logger";
import { EnvSecretProvider } from "./providers/env.js";
import { createVaultProvider } from "./providers/vault.js";
import { SecretResolver } from "./resolver.js";
import type { SecretProviderAdapter, SecretProvider as SecretProviderId } from "./types.js";

/**
 * Set `POLARIS_SECRET_PROVIDER_STRICT=true` to turn the production-with-`env:`
 * warning into a startup failure.
 */
export const SECRET_PROVIDER_STRICT_ENV_VAR = "POLARIS_SECRET_PROVIDER_STRICT";

export interface CreateSecretResolverOptions {
  /** Parsed `secretProviderEnvSchema` output. */
  readonly config: SecretProviderConfig;
  /** Frozen `loadEnv()` snapshot. NOT `process.env`. */
  readonly env: EnvSource;
  readonly logger: Logger;
  /** `POLARIS_ENV` — the deployment environment, not a row environment. */
  readonly deploymentEnvironment: string;
  /** Overrides the `POLARIS_SECRET_PROVIDER_STRICT` lookup; for tests. */
  readonly strict?: boolean;
}

/** Thrown when strict mode refuses a provider that is unfit for production. */
export class InsecureSecretProviderError extends Error {
  constructor(provider: string) {
    super(
      `secret provider "${provider}" is not permitted in production when ` +
        `${SECRET_PROVIDER_STRICT_ENV_VAR}=true. Environment-variable secrets are a ` +
        "local-development affordance: they sit in the process environment of every " +
        "replica, appear in crash dumps and orchestrator introspection, and cannot be " +
        "rotated without a redeploy. Set POLARIS_SECRET_PROVIDER=vault.",
    );
    this.name = "InsecureSecretProviderError";
  }
}

export function createSecretResolver(options: CreateSecretResolverOptions): SecretResolver {
  const { config, env, logger, deploymentEnvironment } = options;
  const strict =
    options.strict ?? String(env[SECRET_PROVIDER_STRICT_ENV_VAR] ?? "").toLowerCase() === "true";

  if (config.provider === "vault") {
    const adapters: Partial<Record<SecretProviderId, SecretProviderAdapter>> = {
      vault: createVaultProvider({
        address: config.vault.address,
        role: config.vault.role,
        kvMount: config.vault.kvMount,
        kubernetesAuthMount: config.vault.kubernetesAuthMount,
        tokenPath: config.vault.tokenPath,
        cacheTtlMs: config.vault.cacheTtlMs,
      }),
    };
    return new SecretResolver({ adapters });
  }

  if (config.provider === "env") {
    if (deploymentEnvironment === "production") {
      if (strict) throw new InsecureSecretProviderError(config.provider);
      // Warn rather than refuse by default. A hard failure here would turn
      // "deploy the new image" into an outage for anyone currently running
      // production on env: secrets, because POLARIS_SECRET_PROVIDER defaults
      // to `env` — the same rollback trap the cutover plan keeps inert env
      // vars around to avoid. Provision Vault, switch the variable, then set
      // POLARIS_SECRET_PROVIDER_STRICT=true to make regression impossible.
      logger.warn(
        {
          component: "secrets.factory",
          provider: config.provider,
          deployment_environment: deploymentEnvironment,
          remediation: `set POLARIS_SECRET_PROVIDER=vault, then ${SECRET_PROVIDER_STRICT_ENV_VAR}=true`,
        },
        "resolving production secrets from environment variables; this is a local-development affordance",
      );
    }
    return new SecretResolver({ adapters: { env: new EnvSecretProvider({ source: env }) } });
  }

  // A reserved-but-unwired slot (aws-secrets-manager, gcp-secret-manager,
  // azure-keyvault). Deliberately builds a resolver with NO adapters rather
  // than throwing here: the failure belongs at the reference that needs it,
  // where SecretProviderNotConfiguredError names the provider and the ref —
  // and classifies permanent, which is correct for a misconfiguration.
  logger.warn(
    { component: "secrets.factory", provider: config.provider },
    "secret provider has no adapter in this build; references to it will fail as not-configured",
  );
  return new SecretResolver({ adapters: {} });
}
