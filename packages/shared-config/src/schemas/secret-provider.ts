import { z } from "zod";
import { durationMsSchema, nonEmptyStringSchema } from "./common.js";

/**
 * Secret-provider runtime config.
 *
 * Polaris stores `(secret_provider, secret_ref)` pairs in PostgreSQL; the
 * value of `secret_provider` selects an adapter at runtime. The adapters
 * themselves live in `@polaris/shared-secrets`; this schema only carries
 * the env-shaped knobs each adapter needs.
 *
 * Env vars:
 *
 *   POLARIS_SECRET_PROVIDER          (`env`) — selected provider for this
 *                                    service instance. Must match a provider
 *                                    slot in `@polaris/shared-secrets`.
 *
 * Vault-only fields (consulted when POLARIS_SECRET_PROVIDER=vault):
 *
 *   POLARIS_VAULT_ADDRESS            required — Vault base URL, no trailing
 *                                    slash, e.g. `https://vault.svc:8200`.
 *   POLARIS_VAULT_ROLE               required — Vault Kubernetes auth role
 *                                    bound to the pod's service account.
 *                                    Convention: `polaris-<environment>`.
 *   POLARIS_VAULT_KV_MOUNT           (`secret`) — Mount path of the KV v2
 *                                    store holding Polaris secrets.
 *   POLARIS_VAULT_K8S_AUTH_MOUNT     (`kubernetes`) — Mount path of Vault's
 *                                    Kubernetes auth plugin.
 *   POLARIS_VAULT_TOKEN_PATH         (`/var/run/secrets/kubernetes.io/serviceaccount/token`)
 *                                    — Path to the pod's service-account JWT.
 *   POLARIS_VAULT_CACHE_TTL_MS       (300000) — In-process cache TTL in
 *                                    milliseconds. Default 5 minutes.
 *
 * The schema is intentionally permissive when `POLARIS_SECRET_PROVIDER=env`:
 * Vault knobs are not consulted and defaults stand in. Services that never
 * need Vault (CLI tools, local dev) can omit the Vault env vars entirely.
 *
 * When the operator selects `POLARIS_SECRET_PROVIDER=vault`, the address and
 * role become required and the schema fails fast at startup. This keeps
 * production from booting in a misconfigured "Vault selected, no address"
 * state.
 */

/**
 * Provider identifiers accepted by config. Matches the `SECRET_PROVIDERS`
 * tuple in `@polaris/shared-secrets/src/types.ts`. We re-declare the tuple
 * here so this package does not depend on `shared-secrets` (avoids a cycle:
 * `shared-secrets` already depends on `shared-config`).
 */
export const secretProviderIdSchema = z.enum([
  "env",
  "vault",
  "aws-secrets-manager",
  "gcp-secret-manager",
  "azure-keyvault",
]);

export type SecretProviderId = z.infer<typeof secretProviderIdSchema>;

/**
 * Default cache TTL for the Vault provider, in milliseconds. Mirrors the
 * default constant exported from `@polaris/shared-secrets` (kept in sync by
 * a code review check, not a runtime import).
 */
export const DEFAULT_VAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_VAULT_KV_MOUNT = "secret";
export const DEFAULT_VAULT_K8S_AUTH_MOUNT = "kubernetes";
export const DEFAULT_K8S_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

const vaultAddressSchema = z
  .string()
  .trim()
  .min(1, "POLARIS_VAULT_ADDRESS must be a non-empty URL")
  .refine(
    (value) => !value.endsWith("/"),
    "POLARIS_VAULT_ADDRESS must not end with '/' (e.g. https://vault.svc:8200)",
  );

/**
 * Secret-provider env schema. Parse this from the service's env source.
 *
 * The result is shaped as `{ provider, vault? }`. When `provider !== "vault"`,
 * the `vault` field is `undefined`; when `provider === "vault"`, the `vault`
 * field carries the typed knobs the adapter constructor needs.
 */
export const secretProviderEnvSchema = z
  .object({
    POLARIS_SECRET_PROVIDER: secretProviderIdSchema.default("env"),
    POLARIS_VAULT_ADDRESS: vaultAddressSchema.optional(),
    POLARIS_VAULT_ROLE: nonEmptyStringSchema.optional(),
    POLARIS_VAULT_KV_MOUNT: nonEmptyStringSchema.default(DEFAULT_VAULT_KV_MOUNT),
    POLARIS_VAULT_K8S_AUTH_MOUNT: nonEmptyStringSchema.default(DEFAULT_VAULT_K8S_AUTH_MOUNT),
    POLARIS_VAULT_TOKEN_PATH: nonEmptyStringSchema.default(DEFAULT_K8S_SA_TOKEN_PATH),
    POLARIS_VAULT_CACHE_TTL_MS: durationMsSchema.default(DEFAULT_VAULT_CACHE_TTL_MS),
  })
  .superRefine((parsed, ctx) => {
    if (parsed.POLARIS_SECRET_PROVIDER === "vault") {
      if (parsed.POLARIS_VAULT_ADDRESS === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["POLARIS_VAULT_ADDRESS"],
          message: "POLARIS_VAULT_ADDRESS is required when POLARIS_SECRET_PROVIDER=vault",
        });
      }
      if (parsed.POLARIS_VAULT_ROLE === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["POLARIS_VAULT_ROLE"],
          message: "POLARIS_VAULT_ROLE is required when POLARIS_SECRET_PROVIDER=vault",
        });
      }
    }
  })
  .transform((parsed): SecretProviderConfig => {
    if (parsed.POLARIS_SECRET_PROVIDER !== "vault") {
      return { provider: parsed.POLARIS_SECRET_PROVIDER };
    }
    // The superRefine above guarantees these are defined when provider is vault.
    if (parsed.POLARIS_VAULT_ADDRESS === undefined || parsed.POLARIS_VAULT_ROLE === undefined) {
      // Unreachable: superRefine surfaces these as validation errors first.
      throw new Error("invariant: vault selected without address/role");
    }
    return {
      provider: "vault",
      vault: {
        address: parsed.POLARIS_VAULT_ADDRESS,
        role: parsed.POLARIS_VAULT_ROLE,
        kvMount: parsed.POLARIS_VAULT_KV_MOUNT,
        kubernetesAuthMount: parsed.POLARIS_VAULT_K8S_AUTH_MOUNT,
        tokenPath: parsed.POLARIS_VAULT_TOKEN_PATH,
        cacheTtlMs: parsed.POLARIS_VAULT_CACHE_TTL_MS,
      },
    };
  });

/**
 * Parsed secret-provider config. The discriminated structure makes the
 * "Vault knobs apply only when Vault is selected" rule visible in the type
 * system without forcing every service to typeguard the provider string.
 */
export type SecretProviderConfig =
  | { readonly provider: Exclude<SecretProviderId, "vault"> }
  | { readonly provider: "vault"; readonly vault: VaultProviderConfig };

export interface VaultProviderConfig {
  readonly address: string;
  readonly role: string;
  readonly kvMount: string;
  readonly kubernetesAuthMount: string;
  readonly tokenPath: string;
  readonly cacheTtlMs: number;
}

/**
 * Env-var names the secret-provider schema reads. Useful for tests and for
 * composing a manual env picker.
 */
export const secretProviderEnvKeys = [
  "POLARIS_SECRET_PROVIDER",
  "POLARIS_VAULT_ADDRESS",
  "POLARIS_VAULT_ROLE",
  "POLARIS_VAULT_KV_MOUNT",
  "POLARIS_VAULT_K8S_AUTH_MOUNT",
  "POLARIS_VAULT_TOKEN_PATH",
  "POLARIS_VAULT_CACHE_TTL_MS",
] as const;
