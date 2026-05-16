export { EnvSecretProvider, type EnvSecretProviderOptions } from "./env.js";
export {
  DEFAULT_AGENT_REREAD_INTERVAL_MS,
  VaultAgentTokenSource,
  type VaultAgentTokenSourceOptions,
} from "./vault-agent-token-source.js";
export type { VaultTokenSource } from "./vault-token-manager.js";
export {
  createVaultProvider,
  DEFAULT_K8S_SA_TOKEN_PATH,
  DEFAULT_VAULT_AGENT_TOKEN_PATH,
  DEFAULT_VAULT_CACHE_TTL_MS,
  DEFAULT_VAULT_INITIAL_BACKOFF_MS,
  DEFAULT_VAULT_K8S_AUTH_MOUNT,
  DEFAULT_VAULT_KV_MOUNT,
  DEFAULT_VAULT_MAX_ATTEMPTS,
  DEFAULT_VAULT_MAX_BACKOFF_MS,
  type VaultProbeResult,
  type VaultProviderOptions,
  VaultSecretProvider,
} from "./vault.js";
// AWS Secrets Manager slot is reserved. See ./aws-secrets-manager.ts.
