/**
 * Secret-provider types.
 *
 * Polaris stores secret *references* in PostgreSQL — never plaintext. A
 * reference is a `(provider, ref)` pair. `provider` selects an adapter; `ref`
 * is the provider-specific lookup key (an env-var name, a Vault path, a cloud
 * KMS ARN, etc.). The provider interface is intentionally narrow so adapters
 * can be swapped without touching call sites.
 *
 * The v1 platform ships the `env` adapter. Vault lands in P11-004 through the
 * same interface. The other enum slots (`vault`, `aws-secrets-manager`,
 * `gcp-secret-manager`, `azure-keyvault`) are reserved so PostgreSQL columns
 * and CLI flags accept the strings on the day those adapters arrive; resolving
 * a reference for an unwired provider throws immediately rather than silently
 * falling back to a default.
 *
 * @see docs/architecture/02-control-plane.md "Secrets"
 * @see docs/architecture/11-production-readiness.md "Secret Management"
 * @see docs/implementation/tasks/P11-004-production-secret-provider.md
 */

/**
 * Provider identifiers as stored in PostgreSQL.
 *
 * The set is closed so a typo in a runtime config or migration fails loudly.
 * Only `env` is wired up in v1; the others are placeholder slots.
 */
export const SECRET_PROVIDERS = [
  "env",
  "vault",
  "aws-secrets-manager",
  "gcp-secret-manager",
  "azure-keyvault",
] as const;

export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

/**
 * Type guard for `SecretProvider`. Useful when reading provider strings out of
 * PostgreSQL, CLI flags, or other untyped sources.
 */
export function isSecretProvider(value: unknown): value is SecretProvider {
  if (typeof value !== "string") return false;
  return (SECRET_PROVIDERS as readonly string[]).includes(value);
}

/**
 * A parsed secret reference.
 *
 * `ref` is opaque to the platform — its meaning is defined by the chosen
 * provider. For `env`, `ref` is an environment-variable name. For `vault`,
 * it will be a path relative to the configured mount (see P11-004).
 */
export interface SecretReference {
  readonly provider: SecretProvider;
  readonly ref: string;
}

/**
 * Provider adapter contract.
 *
 * Every adapter implements exactly one method: `getSecret(ref) -> Promise<string>`.
 * Adapters are responsible for their own caching, lease handling, and transport
 * concerns. They must:
 *
 *   - never log the resolved secret value, even at debug level
 *   - never include the resolved secret value in thrown errors
 *   - throw `SecretNotFoundError` when the reference does not resolve
 *   - throw `SecretProviderError` for transport / auth failures
 *
 * The interface is intentionally Vault-compatible: a Vault adapter wraps an
 * authenticated client, a token refresh loop, and an in-memory cache, but
 * still exposes only `getSecret`.
 */
export interface SecretProviderAdapter {
  /**
   * Stable identifier matching the `SecretProvider` enum slot this adapter
   * services. The resolver uses it to route references.
   */
  readonly provider: SecretProvider;
  /**
   * Resolve a reference to its plaintext value.
   *
   * @throws {SecretNotFoundError} when `ref` does not exist.
   * @throws {SecretProviderError} for transport, auth, or adapter failures.
   */
  getSecret(ref: string): Promise<string>;
}

/**
 * Shape of the canonical Polaris secret-reference string.
 *
 * Two forms are accepted at the parser level:
 *
 *   1. Object form (`{ provider, ref }`) — preferred for code paths reading
 *      PostgreSQL rows where columns are already split.
 *   2. String form (`"<provider>:<ref>"`) — convenient for CLI flags, log
 *      diagnostics, and tests. The colon separator is the cleanest delimiter
 *      that does not collide with the existing provider names or common ref
 *      shapes (env var names, Vault paths, ARNs).
 */
export type SecretReferenceInput = SecretReference | string;
