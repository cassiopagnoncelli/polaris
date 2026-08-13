/**
 * `@polaris/shared-secrets` — provider-based secret reference resolver and
 * platform-standard hashing primitive.
 *
 * Polaris stores `(secret_provider, secret_ref)` pairs in PostgreSQL and
 * resolves them through pluggable provider adapters. v1 ships the `env`
 * adapter; the Vault adapter lands in P11-004 through the same interface.
 *
 * The package also owns the workspace's argon2id hashing primitive
 * ({@link hashSecret} / {@link verifySecret}). Both the ingester and the
 * polaris CLI consume it; no parallel hashing library is permitted.
 *
 * Hard rules baked in:
 *
 *   - PostgreSQL stores references, never plaintext.
 *   - Adapters implement exactly one method: `getSecret(ref) -> Promise<string>`.
 *   - Resolved secret values must never appear in logs, audit records, DLQ
 *     payloads, delivery records, error messages, or exports.
 *   - Provider slots for future adapters (`vault`, `aws-secrets-manager`,
 *     `gcp-secret-manager`, `azure-keyvault`) are reserved in the type so
 *     PostgreSQL columns and CLI flags accept them on day one. References to
 *     an unwired slot throw `SecretProviderNotConfiguredError`.
 *
 * Typical usage:
 *
 * ```ts
 * import { loadEnv } from "@polaris/shared-config";
 * import { EnvSecretProvider, SecretResolver } from "@polaris/shared-secrets";
 *
 * const source = loadEnv();
 * const resolver = new SecretResolver({
 *   adapters: { env: new EnvSecretProvider({ source }) },
 * });
 *
 * const token = await resolver.resolve({
 *   provider: "env",
 *   ref: "META_CAPI_TOKEN_STOREFRONT_PROD",
 * });
 * // hand `token` straight to the destination client; do not log it.
 * ```
 *
 * @see docs/architecture/02-control-plane.md "Secrets"
 * @see docs/architecture/11-production-readiness.md "Secret Management"
 * @see docs/implementation/tasks/P11-004-production-secret-provider.md
 */

export { classifySecretFailure, type SecretFailureClass } from "./classify.js";
export {
  SecretError,
  SecretNotFoundError,
  SecretProviderError,
  SecretProviderNotConfiguredError,
  SecretReferenceParseError,
} from "./errors.js";
export {
  type CreateSecretResolverOptions,
  createSecretResolver,
  InsecureSecretProviderError,
  SECRET_PROVIDER_STRICT_ENV_VAR,
} from "./factory.js";
export {
  hashSecret,
  POLARIS_HASH_ALGORITHM,
  type PolarisHashAlgorithm,
  verifySecret,
} from "./hashing.js";
export {
  createVaultProvider,
  DEFAULT_K8S_SA_TOKEN_PATH,
  DEFAULT_VAULT_CACHE_TTL_MS,
  DEFAULT_VAULT_K8S_AUTH_MOUNT,
  DEFAULT_VAULT_KV_MOUNT,
  EnvSecretProvider,
  type EnvSecretProviderOptions,
  type VaultProbeResult,
  type VaultProviderOptions,
  VaultSecretProvider,
} from "./providers/index.js";
export { formatSecretReference, parseSecretReference } from "./reference.js";
export { SecretResolver, type SecretResolverOptions } from "./resolver.js";
export {
  isSecretProvider,
  SECRET_PROVIDERS,
  type SecretProvider,
  type SecretProviderAdapter,
  type SecretReference,
  type SecretReferenceInput,
} from "./types.js";
