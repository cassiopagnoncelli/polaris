export { EnvSecretProvider, type EnvSecretProviderOptions } from "./env.js";
export {
  createVaultProvider,
  DEFAULT_K8S_SA_TOKEN_PATH,
  DEFAULT_VAULT_CACHE_TTL_MS,
  DEFAULT_VAULT_K8S_AUTH_MOUNT,
  DEFAULT_VAULT_KV_MOUNT,
  type VaultProbeResult,
  type VaultProviderOptions,
  VaultSecretProvider,
} from "./vault.js";
// AWS Secrets Manager slot is reserved. See ./aws-secrets-manager.ts.
