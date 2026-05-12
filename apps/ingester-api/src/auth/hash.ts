/**
 * argon2id hash verification for API key authentication.
 *
 * API keys are stored as argon2id hashes (`packages/shared-db` `api_keys.hash`).
 * The actual primitive lives in `@polaris/shared-secrets` so the ingester and
 * the polaris CLI lifecycle commands (P6-003) consume the same implementation
 * — there is exactly one argon2id integration in the workspace.
 *
 * This module keeps `verifyApiKeyHash` as a thin re-export so the auth layer's
 * import surface does not change. Issuance lives entirely in the lifecycle
 * CLI; the ingester only ever calls verify on the hot path.
 *
 * @see packages/shared-secrets/src/hashing.ts
 * @see docs/architecture/02-control-plane.md "API Keys"
 * @see docs/implementation/tasks/P6-003-api-key-lifecycle-cli.md
 */

import { verifySecret } from "@polaris/shared-secrets";

/**
 * Verify a plaintext API key secret against a stored argon2id hash.
 *
 * Thin alias of `verifySecret` from `@polaris/shared-secrets`. The signature
 * is preserved verbatim so callers (`auth/service.ts`, tests) do not need to
 * change.
 *
 * @param plaintext  the secret tail from the request header
 * @param hash       the PHC string stored in `api_keys.hash`
 * @param algorithm  the algorithm tag stored in `api_keys.hash_algorithm`
 */
export async function verifyApiKeyHash(
  plaintext: string,
  hash: string,
  algorithm: string,
): Promise<boolean> {
  return verifySecret(plaintext, hash, algorithm);
}
